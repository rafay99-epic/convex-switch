/**
 * migrate — a one-time, mandatory, prompt-gated vault upgrade for users coming
 * from an older version. On the first *interactive* command against a legacy
 * vault, the user is shown a mandatory prompt; pressing Enter re-secures every
 * token in the best available backend, upgrades the on-disk format, stamps the
 * schema version, and the prompt never appears again.
 *
 * Non-interactive callers (the cd-hook `cvx activate -q`, scripts, completion)
 * are NOT prompted — legacy records still resolve, so they keep working, and
 * the prompt fires on the next interactive run.
 */

import { createInterface } from "node:readline/promises";

import {
  SCHEMA,
  type Accounts,
  type Config,
  readConfig,
  writeConfig,
  readAccounts,
  writeAccounts,
  tokenOf,
  makeTokenRecord,
  activeAccountName,
  writeActive,
} from "./store";
import { bold, dim, green, yellow, red } from "./ui";

/**
 * Commands that must never trigger the interactive migration: the cd-hook
 * (`activate`), prompt segment (`prompt`), scripting (`which`), and the
 * completion system (`completions`). EVERYTHING a human types interactively —
 * including bare `cvx`, `help`, and `version` — goes through migration, so an
 * upgrading user sees the prompt no matter what their first command is.
 */
export const MIGRATION_EXEMPT = new Set<string | undefined>([
  "activate",
  "prompt",
  "which",
  "completions",
  "completion",
]);

export function migrationNeeded(): boolean {
  return (readConfig().schemaVersion ?? 1) < SCHEMA;
}

/**
 * Prompt-and-migrate if the vault is legacy. Returns after the vault is current
 * (or after deferring in a non-interactive context). Throws only on a genuine
 * failure (which the top-level handler turns into a clean error).
 */
export async function maybeMigrate() {
  const cfg = readConfig();
  if ((cfg.schemaVersion ?? 1) >= SCHEMA) return; // already current

  const accounts = readAccounts(); // throws on a corrupt vault → handled upstream
  const names = Object.keys(accounts);

  // Nothing to secure — stamp the version and move on, no prompt.
  if (!names.length) {
    writeConfig({ ...cfg, schemaVersion: SCHEMA });
    return;
  }

  // Can't prompt without a real terminal (cd-hook, scripts). Defer: legacy
  // records still resolve, so the command runs; the prompt fires next time.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  console.log();
  console.log(`${yellow("▲")} ${bold("Convex Switch needs to migrate your data to a new format.")}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Enter confirms; Ctrl-C cancels the command (migration not done).
    await rl.question(dim("  Press Enter to migrate · Ctrl-C to cancel "));
  } finally {
    rl.close();
  }

  process.stdout.write(dim("  Migrating… "));
  runMigration(accounts, cfg);
}

/**
 * Re-secure every token into the encrypted FILE vault (chmod 600) and stamp the
 * schema. The migration deliberately does NOT touch the OS keychain: a keychain
 * write can pop a blocking system dialog (locked keychain, SSH, headless) and
 * this is a mandatory step every user hits. Keychain remains an explicit,
 * user-initiated opt-in via `cvx keychain enable`.
 */
function runMigration(accounts: Accounts, cfg: Config) {
  const names = Object.keys(accounts);

  // Read every token up front (legacy inline tokens resolve via tokenOf).
  // Abort cleanly before touching anything if one can't be read.
  const tokens: Record<string, string> = {};
  for (const n of names) {
    const t = tokenOf(n, accounts[n]);
    if (t == null) {
      console.log(red("failed"));
      throw new Error(`couldn't read the stored token for "${n}" — nothing was changed.`);
    }
    tokens[n] = t;
  }

  // Rewrite records in the file vault (makeTokenRecord("file", …) can't fail).
  const next: Accounts = {};
  for (const n of names) {
    const rec = makeTokenRecord("file", n, tokens[n]);
    next[n] = { teams: accounts[n].teams, addedAt: accounts[n].addedAt, ...rec };
  }

  writeAccounts(next);
  writeConfig({ ...cfg, storage: "file", schemaVersion: SCHEMA });
  const active = activeAccountName(next);
  if (active) writeActive(active);

  console.log(green("done"));
  console.log(`${green("✓")} ${bold("You're good to go.")}`);
  console.log();
}
