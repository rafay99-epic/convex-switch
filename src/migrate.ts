/**
 * migrate — a one-time, mandatory, prompt-gated vault upgrade for users coming
 * from an older version. On the first *interactive* command against a legacy
 * vault, the user is shown a mandatory prompt; pressing Enter rewrites legacy
 * records into the current on-disk format, stamps the schema version, and the
 * prompt never appears again.
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
  withTokenRecord,
  currentConvexToken,
  activeAccountName,
  writeActive,
} from "./store";
import { bold, dim, green, yellow, red, vexTag } from "./ui";

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

/**
 * Prompt-and-migrate if the vault is legacy. Returns after the vault is current
 * (or after deferring in a non-interactive context). Throws only on a genuine
 * failure (which the top-level handler turns into a clean error).
 */
export async function maybeMigrate() {
  const cfg = readConfig();
  if ((cfg.schemaVersion ?? 1) >= SCHEMA) return; // already current

  const accounts = readAccounts(); // throws on a corrupt vault → handled upstream

  // Nothing to secure — stamp the version and move on, no prompt.
  if (!Object.keys(accounts).length) {
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
  // Re-read the vault: another cvx command may have changed it while the
  // prompt sat open, and migrating a stale snapshot would discard its work.
  runMigration(readAccounts(), readConfig());
}

/**
 * Rewrite legacy inline-token records into the current file-vault shape
 * (chmod 600) and stamp the schema. Keychain/DPAPI-backed records are already
 * in the current shape and keep their secrets where they are — migration never
 * copies a keychain secret into the plaintext file, and never writes TO the
 * OS keychain either (a keychain write can pop a blocking system dialog, and
 * this is a mandatory step every user hits). Keychain remains an explicit
 * opt-in via `cvx keychain enable`.
 */
function runMigration(accounts: Accounts, cfg: Config) {
  const next: Accounts = {};
  for (const [n, acc] of Object.entries(accounts)) {
    if (acc.keychain || acc.enc || acc.pw) {
      next[n] = acc; // already in a current, secured shape — leave untouched
      continue;
    }
    // Read the legacy inline token; abort cleanly before touching anything if
    // it can't be resolved.
    const t = tokenOf(n, acc);
    if (t == null) {
      console.log(red("failed"));
      throw new Error(`couldn't read the stored token for "${n}" — nothing was changed.`);
    }
    next[n] = withTokenRecord(acc, makeTokenRecord("file", n, t));
  }

  writeAccounts(next);
  writeConfig({ ...cfg, storage: cfg.storage ?? "file", schemaVersion: SCHEMA });
  const cur = currentConvexToken();
  const active = activeAccountName(next);
  if (active && cur) writeActive(active, cur);

  console.log(green("done"));
  console.log(`${green("✓")} ${bold("You're good to go.")}${vexTag("happy")}`);
  console.log();
}
