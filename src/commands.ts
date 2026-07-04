/** commands — one function per subcommand. Glue between store + ui. */

import { existsSync, statSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { type Shell, hookFor, detectShell, SHELLS } from "./hooks";
import { hasCommand, isWindows, openUrl } from "./system";
import { type Backend, backendLabel } from "./keychain";
import { completionFor } from "./completions";
import {
  HOME,
  VERSION,
  type Team,
  type Account,
  type Accounts,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  readConfig,
  writeConfig,
  currentConvexToken,
  setConvexToken,
  verifyToken,
  resolveLink,
  canon,
  shortPath,
  tokenOf,
  makeTokenRecord,
  storageBackend,
  detectBackend,
  deleteToken,
  readActive,
  writeActive,
  clearActive,
  activeAccountName,
  projectDeployment,
} from "./store";
import { bold, dim, green, yellow, red, cyan, die, teamLabel } from "./ui";
import { parseFlags } from "./args";

// --- small helpers ----------------------------------------------------------

function requireAccount(accounts: Accounts, name: string): Account {
  const acc = accounts[name];
  if (!acc)
    die(
      `Unknown account ${bold(name)}. Known: ${Object.keys(accounts).join(", ") || "(none)"}`,
    );
  return acc;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

// --- add / login ------------------------------------------------------------

export async function cmdAdd(args: string[]) {
  const flags = parseFlags(args);
  let name = flags._[0];
  let token: string | null = (flags.token as string) ?? null;

  if (!token) {
    token = currentConvexToken();
    if (!token)
      die(
        `No token given and ${cyan("~/.convex/config.json")} has none.\n` +
          `  Log into the account first:  ${bold("npx convex login")}\n` +
          `  or:  ${bold("cvx login <name>")}   (logs in, then stores it)`,
      );
    console.log(dim(`Using the token currently in ~/.convex/config.json`));
  }

  process.stdout.write("Verifying with Convex… ");
  let teams: Team[] = [];
  try {
    teams = await verifyToken(token);
    console.log(green("ok"));
  } catch (e) {
    console.log(red("failed"));
    die(String((e as Error).message));
  }

  if (!name) name = teams[0]?.slug ?? "account";
  const accounts = readAccounts();
  if (accounts[name] && !flags.force)
    die(`Account ${bold(name)} already exists. Use ${bold("--force")} to overwrite.`);

  const backend = storageBackend();
  let rec;
  try {
    rec = makeTokenRecord(backend, name, token);
  } catch (e) {
    die(`Couldn't store the token: ${(e as Error).message}`);
  }
  accounts[name] = { ...rec, teams, addedAt: new Date().toISOString() };
  writeAccounts(accounts);
  if (token === currentConvexToken()) writeActive(name);

  const where = backend === "file" ? "" : dim(` (${backendLabel(backend)})`);
  console.log(`${green("✓")} Stored account ${bold(name)} ${teamLabel(accounts[name])}${where}`);
  console.log(dim(`  Next: cd into a project and run  ${bold(`cvx link ${name}`)}`));
}

export function cmdLogin(args: string[]) {
  const name = parseFlags(args)._[0];
  if (!name) die(`Usage: ${bold("cvx login <name>")}`);
  if (!hasCommand("npx"))
    die(
      `${bold("npx")} (Node.js) was not found on your PATH.\n` +
        `  Convex's CLI runs via npx — install Node from https://nodejs.org and retry.\n` +
        `  Already logged in elsewhere? Use ${bold(`cvx add ${name}`)} to store the current login.`,
    );
  console.log(dim("Opening Convex login (forces a fresh browser sign-in)…"));
  const r = spawnSync("npx", ["--yes", "convex", "login", "--force"], {
    stdio: "inherit",
    shell: isWindows,
  });
  if (r.error) die(`Could not run convex login: ${r.error.message}`);
  if (r.status !== 0) die("convex login did not complete.");
  return cmdAdd([name, "--force"]);
}

/** Re-authenticate an existing account (sign in again, refresh its token). */
export function cmdRefresh(args: string[]) {
  const name = parseFlags(args)._[0];
  if (!name) die(`Usage: ${bold("cvx refresh <account>")}`);
  const accounts = readAccounts();
  if (!accounts[name])
    die(`Unknown account ${bold(name)}. Use ${bold(`cvx login ${name}`)} to add it.`);
  if (!hasCommand("npx")) die(`${bold("npx")} (Node.js) not found — needed to re-authenticate.`);
  console.log(dim(`Re-authenticating ${bold(name)} — sign into that account in the browser…`));
  const r = spawnSync("npx", ["--yes", "convex", "login", "--force"], {
    stdio: "inherit",
    shell: isWindows,
  });
  if (r.error) die(`Could not run convex login: ${r.error.message}`);
  if (r.status !== 0) die("convex login did not complete.");
  return cmdAdd([name, "--force"]);
}

// --- link / unlink / rename / rm --------------------------------------------

export function cmdLink(args: string[]) {
  const flags = parseFlags(args);
  const account = flags._[0];
  if (!account) die(`Usage: ${bold("cvx link <account> [path]")}`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, account);

  const input = flags._[1] ?? process.cwd();
  if (!existsSync(resolve(input))) die(`Path does not exist: ${input}`);
  if (!statSync(resolve(input)).isDirectory()) die(`Not a directory: ${input}`);
  const target = canon(input);

  const links = readLinks();
  links[target] = account;
  writeLinks(links);
  console.log(
    `${green("✓")} Linked ${bold(shortPath(target))} → ${bold(account)} ${teamLabel(acc)}`,
  );
}

export function cmdUnlink(args: string[]) {
  const target = canon(args[0] ?? process.cwd());
  const links = readLinks();
  if (!links[target]) die(`No link at ${shortPath(target)}`);
  delete links[target];
  writeLinks(links);
  console.log(`${green("✓")} Unlinked ${bold(shortPath(target))}`);
}

export function cmdRename(args: string[]) {
  const flags = parseFlags(args);
  const [oldName, newName] = flags._;
  if (!oldName || !newName) die(`Usage: ${bold("cvx rename <old> <new>")}`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, oldName);
  if (oldName === newName) return console.log(dim("Same name — nothing to do."));
  if (accounts[newName] && !flags.force)
    die(`Account ${bold(newName)} already exists. Use ${bold("--force")} to overwrite.`);

  if (acc.keychain) {
    // secret is keyed by name in the OS keychain — move it.
    const tok = tokenOf(oldName, acc);
    if (tok == null) die(`Couldn't read ${bold(oldName)}'s token from the keychain.`);
    const rec = makeTokenRecord(detectBackend(), newName, tok);
    deleteToken(oldName, acc);
    accounts[newName] = { teams: acc.teams, addedAt: acc.addedAt, ...rec };
  } else {
    accounts[newName] = acc; // file/dpapi records travel with the object
  }
  delete accounts[oldName];
  writeAccounts(accounts);

  const links = readLinks();
  let moved = 0;
  for (const p of Object.keys(links))
    if (links[p] === oldName) {
      links[p] = newName;
      moved++;
    }
  writeLinks(links);
  if (readActive() === oldName) writeActive(newName);

  console.log(
    `${green("✓")} Renamed ${bold(oldName)} → ${bold(newName)}${moved ? dim(` (${moved} link(s) updated)`) : ""}`,
  );
}

export function cmdRm(args: string[]) {
  const name = parseFlags(args)._[0];
  if (!name) die(`Usage: ${bold("cvx rm <account>")}`);
  const accounts = readAccounts();
  const acc = requireAccount(accounts, name);
  deleteToken(name, acc); // remove OS-keychain secret if any (no-op otherwise)
  delete accounts[name];
  writeAccounts(accounts);
  if (readActive() === name) clearActive();

  const links = readLinks();
  let removed = 0;
  for (const [p, a] of Object.entries(links))
    if (a === name) {
      delete links[p];
      removed++;
    }
  writeLinks(links);
  console.log(
    `${green("✓")} Removed account ${bold(name)}${removed ? dim(` (and ${removed} link(s))`) : ""}`,
  );
}

// --- activate (the hot path) + interactive use ------------------------------

/**
 * activate — called by the shell hook on every cd. Must NEVER throw and break
 * the prompt. For inline (file) tokens it compares tokens directly; for
 * keychain/DPAPI tokens (a slow lookup) it trusts the active-marker so the hot
 * path stays fast.
 */
export function cmdActivate(args: string[]) {
  const flags = parseFlags(args);
  const quiet = flags.q || flags.quiet;
  try {
    const link = resolveLink(flags._[0] ?? process.cwd());
    if (!link) {
      if (!quiet) console.log(dim("No account linked to this directory."));
      return;
    }
    const accounts = readAccounts();
    const acc = accounts[link.account];
    if (!acc) {
      if (!quiet) console.log(yellow(`Linked to unknown account "${link.account}".`));
      return;
    }
    const expensive = !!acc.keychain || !!acc.enc; // reading the token spawns a process
    if (expensive && readActive() === link.account && currentConvexToken() != null) {
      if (!quiet)
        console.log(`${green("●")} ${bold(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
      return; // trust the marker instead of a slow secret lookup
    }
    const token = tokenOf(link.account, acc);
    if (token == null) {
      if (!quiet) console.error(red("cvx: ") + `couldn't read the token for ${link.account}`);
      return;
    }
    if (currentConvexToken() === token) {
      writeActive(link.account);
      if (!quiet)
        console.log(`${green("●")} ${bold(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
      return;
    }
    setConvexToken(token);
    writeActive(link.account);
    console.log(`${cyan("⇄")} convex account → ${bold(link.account)} ${teamLabel(acc)}`);
  } catch (e) {
    if (!quiet) console.error(red("cvx: ") + (e as Error).message);
  }
}

/** use — like activate, but if the dir isn't linked, pick an account interactively. */
export async function cmdUse(args: string[]) {
  const flags = parseFlags(args);
  if (resolveLink(flags._[0] ?? process.cwd())) return cmdActivate(args);

  const accounts = readAccounts();
  const names = Object.keys(accounts);
  if (!names.length) die("No accounts yet. Run `cvx login <name>` first.");
  if (!process.stdin.isTTY)
    die(
      `This directory isn't linked to an account.\n  Run ${bold("cvx link <account>")} — or ${bold("cvx use")} in an interactive terminal to pick one.`,
    );

  const chosen = pickWithFzf(names) ?? (await pickNumbered(names));
  if (!chosen) return;
  const acc = accounts[chosen];
  const token = tokenOf(chosen, acc);
  if (token == null) die(`Couldn't read the token for ${bold(chosen)}.`);
  setConvexToken(token);
  writeActive(chosen);
  console.log(`${cyan("⇄")} convex account → ${bold(chosen)} ${teamLabel(acc)}`);

  const here = canon(process.cwd());
  const yn = await ask(dim(`Link ${shortPath(here)} to ${chosen}? [y/N] `));
  if (/^y(es)?$/i.test(yn)) {
    const links = readLinks();
    links[here] = chosen;
    writeLinks(links);
    console.log(`${green("✓")} Linked — it'll switch automatically from now on.`);
  }
}

function pickWithFzf(names: string[]): string | null {
  if (!hasCommand("fzf")) return null;
  const r = spawnSync("fzf", ["--height=40%", "--reverse", "--prompt", "account> "], {
    input: names.join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  const out = (r.stdout || "").trim();
  return out || null;
}

async function pickNumbered(names: string[]): Promise<string | null> {
  console.log(bold("Pick an account to activate:"));
  names.forEach((n, i) => console.log(`  ${cyan(String(i + 1))}  ${n}`));
  const answer = await ask("> ");
  const idx = Number.parseInt(answer, 10);
  if (!Number.isInteger(idx) || idx < 1 || idx > names.length) {
    console.log(dim("Cancelled."));
    return null;
  }
  return names[idx - 1];
}

// --- status / accounts / ls / which / prompt --------------------------------

export function cmdStatus(args: string[] = []) {
  const flags = parseFlags(args);
  const accounts = readAccounts();
  const active = activeAccountName(accounts);
  const link = resolveLink(process.cwd());
  const loggedIn = currentConvexToken() != null;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          active,
          activeTeams: active ? accounts[active]?.teams.map((t) => t.slug) : [],
          linked: link?.account ?? null,
          linkPath: link?.path ?? null,
          dir: canon(process.cwd()),
          loggedIn,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(bold("Active convex account:"));
  if (active) console.log(`  ${green("●")} ${bold(active)} ${teamLabel(accounts[active])}`);
  else if (loggedIn)
    console.log(`  ${yellow("●")} unknown login ${dim("(run `cvx add <name>` to name it)")}`);
  else console.log(`  ${dim("(not logged in)")}`);

  console.log(bold("\nThis directory:"));
  if (link)
    console.log(
      `  linked to ${bold(link.account)}${
        link.path !== canon(process.cwd()) ? dim(`  (via ${shortPath(link.path)})`) : ""
      }`,
    );
  else console.log(dim("  not linked"));
}

export function cmdAccounts(args: string[] = []) {
  const flags = parseFlags(args);
  const accounts = readAccounts();
  const names = Object.keys(accounts);
  if (flags.names) {
    // machine-readable, for shell completion — bare names, one per line.
    for (const n of names) console.log(n);
    return;
  }
  if (!names.length)
    return console.log(dim("No accounts yet. Run `cvx login <name>` or `cvx add`."));
  const active = activeAccountName(accounts);
  console.log(bold("Accounts:"));
  for (const [name, acc] of Object.entries(accounts)) {
    const dot = name === active ? green("●") : dim("○");
    const store = acc.keychain ? dim("· keychain") : acc.enc ? dim("· encrypted") : "";
    console.log(`  ${dot} ${bold(name.padEnd(14))} ${teamLabel(acc)} ${store}`);
  }
}

export function cmdLs() {
  const links = readLinks();
  const entries = Object.entries(links);
  if (!entries.length)
    return console.log(dim("No projects linked yet. Run `cvx link <account>` in a project."));
  const here = canon(process.cwd());
  console.log(bold("Linked projects:"));
  for (const [path, account] of entries.sort()) {
    const marker = path === here ? cyan("→") : " ";
    console.log(`  ${marker} ${bold(account.padEnd(14))} ${shortPath(path)}`);
  }
}

export function cmdWhich(args: string[]) {
  const link = resolveLink(args[0] ?? process.cwd());
  if (!link) {
    console.log("");
    process.exit(1);
  }
  console.log(link.account);
}

/** prompt — fast, no-network, prints the active account name (for a shell prompt). */
export function cmdPrompt() {
  try {
    const name = readActive();
    if (name && readAccounts()[name]) process.stdout.write(name);
  } catch {
    /* a prompt segment must never error */
  }
}

// --- run (per-command account, no global change) ----------------------------

/** run <account> [--] <command…> — run a command as an account without switching. */
export function cmdRun(args: string[]) {
  if (!args.length)
    die(`Usage: ${bold("cvx run <account> -- <command…>")}   (account "." = this dir's account)`);

  let account: string | null;
  let rest: string[];
  if (args[0] === "--") {
    account = null;
    rest = args.slice(1);
  } else {
    account = args[0] === "." ? null : args[0];
    rest = args[1] === "--" ? args.slice(2) : args.slice(1);
  }

  if (account === null) {
    const link = resolveLink(process.cwd());
    if (!link) die("This directory isn't linked. Give an account: `cvx run <account> -- <cmd>`.");
    account = link.account;
  }
  if (!rest.length) die(`No command given. Usage: ${bold("cvx run <account> -- <command…>")}`);

  const accounts = readAccounts();
  const acc = requireAccount(accounts, account);
  const token = tokenOf(account, acc);
  if (token == null) die(`Couldn't read the token for ${bold(account)}.`);

  const [cmd, ...cmdArgs] = rest;
  const r = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    env: { ...process.env, CONVEX_OVERRIDE_ACCESS_TOKEN: token },
    shell: isWindows, // resolve .cmd shims on Windows
  });
  if (r.error) {
    const err = r.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") die(`Command not found: ${bold(cmd)}`);
    die(`Could not run ${bold(cmd)}: ${err.message}`);
  }
  process.exit(r.status ?? 1);
}

// --- open (dashboard) -------------------------------------------------------

export function cmdOpen() {
  const dep = projectDeployment(process.cwd());
  const url = dep
    ? `https://dashboard.convex.dev/d/${dep}`
    : "https://dashboard.convex.dev";
  console.log(
    dim(dep ? `Opening the Convex dashboard for ${dep}…` : "No CONVEX_DEPLOYMENT here — opening the Convex dashboard…"),
  );
  if (!openUrl(url)) die(`Couldn't open a browser. Visit: ${cyan(url)}`);
}

// --- keychain ---------------------------------------------------------------

export function cmdKeychain(args: string[]) {
  const sub = args[0] || "status";
  const accounts = readAccounts();
  const cfg = readConfig();
  const current: Backend = cfg.storage ?? "file";
  const available = detectBackend();

  if (sub === "status") {
    console.log(bold("Token storage") + "\n");
    console.log(`  current    ${bold(current)} ${dim(`(${backendLabel(current)})`)}`);
    console.log(`  available  ${bold(available)} ${dim(`(${backendLabel(available)})`)}`);
    if (current === "file" && available !== "file")
      console.log(dim(`\n  Run \`cvx keychain enable\` to move tokens into ${backendLabel(available)}.`));
    return;
  }
  if (sub === "enable") {
    if (available === "file")
      die(
        "No OS keychain is available here.\n  macOS uses Keychain; Linux needs `secret-tool` (libsecret); Windows uses DPAPI.",
      );
    migrateStorage(accounts, available);
    writeConfig({ ...cfg, storage: available });
    console.log(
      `${green("✓")} Moved ${Object.keys(accounts).length} account(s) into ${bold(backendLabel(available))}.`,
    );
    return;
  }
  if (sub === "disable") {
    migrateStorage(accounts, "file");
    writeConfig({ ...cfg, storage: "file" });
    console.log(`${green("✓")} Moved tokens back to the encrypted file vault.`);
    return;
  }
  die(`Usage: ${bold("cvx keychain <status|enable|disable>")}`);
}

/** Move every account's token to `target`, then clean up the old keychain secrets. */
function migrateStorage(accounts: Accounts, target: Backend) {
  const names = Object.keys(accounts);
  if (!names.length) return;
  // 1) read every token up front — abort cleanly if any can't be read.
  const tokens: Record<string, string> = {};
  for (const name of names) {
    const t = tokenOf(name, accounts[name]);
    if (t == null) die(`Couldn't read the token for ${bold(name)} — aborting, nothing changed.`);
    tokens[name] = t;
  }
  // 2) write all to the new backend (side effects), building new records.
  const next: Accounts = {};
  for (const name of names) {
    const rec = makeTokenRecord(target, name, tokens[name]); // may throw before we commit
    next[name] = { teams: accounts[name].teams, addedAt: accounts[name].addedAt, ...rec };
  }
  // 3) commit, then delete now-orphaned keychain secrets.
  writeAccounts(next);
  for (const name of names) {
    if (accounts[name].keychain && !next[name].keychain) deleteToken(name, accounts[name]);
  }
}

// --- version / doctor -------------------------------------------------------

export function cmdVersion() {
  console.log(VERSION);
}

/** Health check: node/npx, Convex login, vault, storage backend, tokens, hook. */
export async function cmdDoctor(args: string[] = []) {
  const flags = parseFlags(args);
  const mark = (b: boolean) => (b ? green("✓") : red("✗"));
  const warn = (b: boolean) => (b ? green("✓") : yellow("!"));
  let healthy = true;
  console.log(bold("cvx doctor") + "\n");

  const npx = hasCommand("npx");
  if (!npx) healthy = false;
  console.log(
    `  ${mark(npx)} node / npx        ${npx ? dim("available") : yellow("missing — needed for `cvx login`")}`,
  );

  const tok = currentConvexToken();
  console.log(
    `  ${warn(!!tok)} convex login      ${tok ? dim("~/.convex/config.json present") : yellow("none yet — run `cvx login <name>`")}`,
  );

  let accounts: Accounts = {};
  let vaultOk = true;
  try {
    accounts = readAccounts();
  } catch {
    vaultOk = false;
    healthy = false;
  }
  const nLink = vaultOk ? Object.keys(readLinks()).length : 0;
  const nAcc = Object.keys(accounts).length;
  console.log(
    `  ${mark(vaultOk)} vault             ${vaultOk ? dim(`${nAcc} account(s), ${nLink} link(s)  ·  ~/.convex-switch`) : red("corrupted — see ~/.convex-switch")}`,
  );

  const backend = storageBackend();
  console.log(`  ${green("✓")} token storage     ${dim(backendLabel(backend))}`);

  const active = vaultOk ? activeAccountName(accounts) : null;
  console.log(`  ${warn(!!active)} active account    ${active ? dim(active) : dim("none active")}`);

  const rcs = [".zshrc", ".bashrc", ".config/fish/config.fish"].map((f) => join(HOME, f));
  const hooked = rcs.some((rc) => existsSync(rc) && readFileSync(rc, "utf8").includes("convex-switch"));
  console.log(
    `  ${warn(hooked)} shell hook        ${hooked ? dim("installed") : yellow("not installed — run `cvx hook --install`")}`,
  );

  // Token health — pings Convex for each account (skip with --no-tokens).
  if (vaultOk && nAcc && flags.tokens !== false && flags["no-tokens"] !== true) {
    console.log(bold("\nToken health:"));
    for (const [name, acc] of Object.entries(accounts)) {
      const t = tokenOf(name, acc);
      if (t == null) {
        console.log(`  ${red("✗")} ${bold(name.padEnd(14))} ${red("token unreadable")}`);
        healthy = false;
        continue;
      }
      try {
        await verifyToken(t);
        console.log(`  ${green("✓")} ${bold(name.padEnd(14))} ${dim("valid")}`);
      } catch (e) {
        const msg = String((e as Error).message);
        const offline = /reach Convex|timed out/.test(msg);
        console.log(
          `  ${offline ? yellow("!") : red("✗")} ${bold(name.padEnd(14))} ${offline ? dim("couldn't check (offline)") : red(msg)}`,
        );
        if (!offline) {
          healthy = false;
          console.log(dim(`      → re-authenticate with  cvx refresh ${name}`));
        }
      }
    }
  }

  console.log();
  console.log(healthy ? green("Everything looks good.") : yellow("Some checks need attention (see above)."));
  if (!healthy) process.exitCode = 1;
}

// --- completions ------------------------------------------------------------

export function cmdCompletions(args: string[]) {
  const shell = parseFlags(args)._[0] || detectShell();
  const script = completionFor(shell);
  if (!script)
    die(`Usage: ${bold("cvx completions <zsh|bash|fish|powershell>")}`);
  process.stdout.write(script);
}

// --- hook -------------------------------------------------------------------

export function cmdHook(args: string[]) {
  const flags = parseFlags(args);
  const shell = ((flags.shell as Shell) || detectShell()) as Shell;
  if (!SHELLS.includes(shell))
    die(`Unknown shell ${bold(String(shell))}. Use --shell ${SHELLS.join("|")}.`);
  const snippet = hookFor(shell);

  if (!flags.install) {
    process.stdout.write(snippet);
    return;
  }
  if (shell === "powershell") return installPwsh(snippet);

  const rcPath: Record<string, string> = {
    zsh: ".zshrc",
    bash: ".bashrc",
    fish: ".config/fish/config.fish",
    nu: ".config/nushell/config.nu",
  };
  const rc = join(HOME, rcPath[shell]);
  const body = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (body.includes("convex-switch")) {
    console.log(yellow(`Hook already present in ${shortPath(rc)} — nothing to do.`));
    return;
  }
  mkdirSync(dirname(rc), { recursive: true });
  appendFileSync(rc, "\n" + snippet);
  console.log(`${green("✓")} Added hook to ${cyan(shortPath(rc))}.`);
  console.log(dim(`  Open a new terminal to activate it.`));
}

function installPwsh(snippet: string) {
  const ask2 = (exe: string) => {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], {
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const profile = ask2("pwsh") || ask2("powershell");
  if (!profile) {
    console.log(yellow("Couldn't find PowerShell. Add this to your $PROFILE manually:") + "\n");
    process.stdout.write(snippet);
    return;
  }
  const body = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (body.includes("convex-switch")) {
    console.log(yellow(`Hook already present in ${profile} — nothing to do.`));
    return;
  }
  mkdirSync(dirname(profile), { recursive: true });
  appendFileSync(profile, "\n" + snippet);
  console.log(`${green("✓")} Added hook to ${cyan(profile)}.`);
  console.log(dim("  Open a new PowerShell window to activate it."));
}
