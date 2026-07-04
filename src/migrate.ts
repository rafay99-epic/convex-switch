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
  detectBackend,
  activeAccountName,
  writeActive,
} from "./store";
import { type Backend, backendLabel } from "./keychain";
import { bold, dim, green, yellow, red } from "./ui";

/** Commands that must never trigger the interactive migration. */
export const MIGRATION_EXEMPT = new Set<string | undefined>([
  "activate",
  "prompt",
  "which",
  "completions",
  "completion",
  "hook",
  "version",
  "-v",
  "--version",
  "help",
  "-h",
  "--help",
  undefined,
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

  const target = detectBackend();
  console.log();
  console.log(`${yellow("▲")}  ${bold("Convex Switch needs to upgrade your saved data.")}`);
  console.log(
    dim(
      `   A vault from an older version was found (${names.length} account${names.length > 1 ? "s" : ""}).`,
    ),
  );
  console.log(
    dim(`   Your tokens will be re-secured in ${bold(backendLabel(target))} and the vault`),
  );
  console.log(dim(`   upgraded to the latest format. This is a one-time step.`));
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Mandatory — the only way forward is to migrate. Ctrl-C cancels the command.
    await rl.question(`${bold("Press Enter to secure & upgrade")} ${dim("(Ctrl-C to cancel)")} `);
  } finally {
    rl.close();
  }

  process.stdout.write(dim("   Migrating… "));
  runMigration(accounts, cfg, target);
}

function runMigration(accounts: Accounts, cfg: Config, preferred: Backend) {
  const names = Object.keys(accounts);

  // 1) Read every token up front (legacy inline tokens resolve via tokenOf).
  //    Abort cleanly before touching anything if one can't be read.
  const tokens: Record<string, string> = {};
  for (const n of names) {
    const t = tokenOf(n, accounts[n]);
    if (t == null) {
      console.log(red("failed"));
      throw new Error(`couldn't read the stored token for "${n}" — nothing was changed.`);
    }
    tokens[n] = t;
  }

  // 2) Build new records in the target backend. If the keychain write fails
  //    (e.g. no keyring), fall back to the file vault so a mandatory migration
  //    can never dead-end.
  const build = (backend: Backend): Accounts => {
    const next: Accounts = {};
    for (const n of names) {
      const rec = makeTokenRecord(backend, n, tokens[n]);
      next[n] = { teams: accounts[n].teams, addedAt: accounts[n].addedAt, ...rec };
    }
    return next;
  };

  let backend = preferred;
  let next: Accounts;
  try {
    next = build(preferred);
  } catch (e) {
    if (preferred === "file") {
      console.log(red("failed"));
      throw e;
    }
    console.log(yellow(`\n   ${backendLabel(preferred)} unavailable — keeping the encrypted file vault.`));
    backend = "file";
    next = build("file");
  }

  // 3) Commit, then stamp the schema + chosen backend.
  writeAccounts(next);
  writeConfig({ ...cfg, storage: backend, schemaVersion: SCHEMA });
  const active = activeAccountName(next);
  if (active) writeActive(active);

  console.log(green("done"));
  console.log();
  console.log(
    `${green("✓")} ${bold("Upgraded.")} ${names.length} account${names.length > 1 ? "s" : ""} secured in ${bold(backendLabel(backend))}.`,
  );
  if (backend !== "file")
    console.log(dim(`   Prefer the file vault? Run  ${bold("cvx keychain disable")}.`));
  console.log();
}
