#!/usr/bin/env bun
/**
 * convex-switch (cvx) — bind Convex accounts to projects and auto-activate
 * the right one when you cd into a project. No deploy keys, no tokens in
 * project files. It swaps the single global ~/.convex/config.json, which is
 * the one place the Convex CLI reads your account from.
 */

import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  appendFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const HOME = homedir();
const VAULT = join(HOME, ".convex-switch");
const ACCOUNTS_FILE = join(VAULT, "accounts.json");
const LINKS_FILE = join(VAULT, "links.json");
const CONVEX_CONFIG = join(HOME, ".convex", "config.json");
const API_TEAMS = "https://api.convex.dev/api/teams";
const CLIENT = "convex-switch/0.1.0";

type Account = {
  token: string;
  teams: { slug: string; name: string }[];
  addedAt: string;
};
type Accounts = Record<string, Account>;
type Links = Record<string, string>; // absolute project path -> account name

// ---------------------------------------------------------------------------
// Small ANSI helpers (no deps)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const red = (s: string) => c("31", s);
const cyan = (s: string) => c("36", s);

function die(msg: string): never {
  console.error(red("✗ ") + msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Vault I/O (all files are chmod 600, dir 700)
// ---------------------------------------------------------------------------

function ensureVault() {
  if (!existsSync(VAULT)) mkdirSync(VAULT, { recursive: true, mode: 0o700 });
  try {
    chmodSync(VAULT, 0o700);
  } catch {}
  if (!existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, {});
  if (!existsSync(LINKS_FILE)) writeJSON(LINKS_FILE, {});
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

const readAccounts = () => readJSON<Accounts>(ACCOUNTS_FILE, {});
const writeAccounts = (a: Accounts) => writeJSON(ACCOUNTS_FILE, a);
const readLinks = () => readJSON<Links>(LINKS_FILE, {});
const writeLinks = (l: Links) => writeJSON(LINKS_FILE, l);

// ---------------------------------------------------------------------------
// Convex global config (the single account switch)
// ---------------------------------------------------------------------------

function currentConvexToken(): string | null {
  try {
    return JSON.parse(readFileSync(CONVEX_CONFIG, "utf8")).accessToken ?? null;
  } catch {
    return null;
  }
}

function setConvexToken(token: string) {
  const dir = dirname(CONVEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Preserve any other fields Convex may keep in the file.
  const existing = readJSON<Record<string, unknown>>(CONVEX_CONFIG, {});
  existing.accessToken = token;
  writeFileSync(CONVEX_CONFIG, JSON.stringify(existing, null, 2) + "\n", {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Verify a token against Convex (also tells us which teams it can see)
// ---------------------------------------------------------------------------

async function verifyToken(token: string): Promise<{ slug: string; name: string }[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(API_TEAMS, {
      headers: { Authorization: `Bearer ${token}`, "Convex-Client": CLIENT },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403)
      throw new Error("token rejected by Convex (expired or invalid)");
    if (!res.ok) throw new Error(`Convex API returned ${res.status}`);
    const teams = (await res.json()) as { slug: string; name: string }[];
    return teams.map((t) => ({ slug: t.slug, name: t.name }));
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Resolve which account a directory belongs to (walk up to nearest link)
// ---------------------------------------------------------------------------

function resolveLink(dir: string): { path: string; account: string } | null {
  const links = readLinks();
  let cur = canon(dir);
  while (true) {
    if (links[cur]) return { path: cur, account: links[cur] };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function teamLabel(acc: Account): string {
  if (!acc.teams.length) return dim("(unverified)");
  const names = acc.teams.map((t) => t.slug).join(", ");
  return dim(names);
}

function mask(token: string): string {
  return token.length <= 10 ? "•".repeat(token.length) : token.slice(0, 6) + "…" + token.slice(-4);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAdd(args: string[]) {
  const flags = parseFlags(args);
  let name = flags._[0];
  let token = flags.token ?? null;

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
  let teams: { slug: string; name: string }[] = [];
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

  accounts[name] = { token, teams, addedAt: new Date().toISOString() };
  writeAccounts(accounts);
  console.log(
    `${green("✓")} Stored account ${bold(name)} ${teamLabel(accounts[name])}`,
  );
  console.log(dim(`  Next: cd into a project and run  ${bold(`cvx link ${name}`)}`));
}

function cmdLogin(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) die(`Usage: ${bold("cvx login <name>")}`);
  // --force bypasses convex's "this device is already authorized" short-circuit,
  // so it actually opens the browser to sign into a *different* account.
  console.log(dim("Opening Convex login (forces a fresh browser sign-in)…"));
  const r = spawnSync("npx", ["--yes", "convex", "login", "--force"], { stdio: "inherit" });
  if (r.status !== 0) die("convex login did not complete");
  // Snapshot whatever token convex just wrote for the account you signed into.
  return cmdAdd([name, "--force"]);
}

function cmdLink(args: string[]) {
  const flags = parseFlags(args);
  const account = flags._[0];
  if (!account) die(`Usage: ${bold("cvx link <account> [path]")}`);
  const accounts = readAccounts();
  if (!accounts[account])
    die(`Unknown account ${bold(account)}. Known: ${Object.keys(accounts).join(", ") || "(none)"}`);

  if (!existsSync(resolve(flags._[1] ?? process.cwd())))
    die(`Path does not exist: ${flags._[1] ?? process.cwd()}`);
  const target = canon(flags._[1] ?? process.cwd());

  const links = readLinks();
  links[target] = account;
  writeLinks(links);
  console.log(
    `${green("✓")} Linked ${bold(shortPath(target))} → ${bold(account)} ${teamLabel(accounts[account])}`,
  );
}

function cmdUnlink(args: string[]) {
  const target = canon(args[0] ?? process.cwd());
  const links = readLinks();
  if (!links[target]) die(`No link at ${shortPath(target)}`);
  delete links[target];
  writeLinks(links);
  console.log(`${green("✓")} Unlinked ${bold(shortPath(target))}`);
}

function cmdRm(args: string[]) {
  const name = args[0];
  if (!name) die(`Usage: ${bold("cvx rm <account>")}`);
  const accounts = readAccounts();
  if (!accounts[name]) die(`Unknown account ${bold(name)}`);
  delete accounts[name];
  writeAccounts(accounts);
  // Drop any links pointing at it.
  const links = readLinks();
  let removed = 0;
  for (const [p, a] of Object.entries(links))
    if (a === name) {
      delete links[p];
      removed++;
    }
  writeLinks(links);
  console.log(`${green("✓")} Removed account ${bold(name)}${removed ? dim(` (and ${removed} link(s))`) : ""}`);
}

/**
 * activate — the workhorse the shell hook calls on every cd. Fast and quiet:
 * if the current dir maps to an account and that account isn't already active,
 * swap ~/.convex/config.json. Otherwise do nothing.
 */
function cmdActivate(args: string[]) {
  const flags = parseFlags(args);
  const quiet = flags.q || flags.quiet;
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
  if (currentConvexToken() === acc.token) {
    if (!quiet)
      console.log(`${green("●")} ${bold(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
    return; // already correct — no write, no noise
  }
  setConvexToken(acc.token);
  // Print a concise switch notice even in quiet/hook mode so you see it on cd.
  console.log(`${cyan("⇄")} convex account → ${bold(link.account)} ${teamLabel(acc)}`);
}

function cmdStatus() {
  const cur = currentConvexToken();
  const accounts = readAccounts();
  const active = Object.entries(accounts).find(([, a]) => a.token === cur);
  console.log(bold("Active convex account:"));
  if (active) console.log(`  ${green("●")} ${bold(active[0])} ${teamLabel(active[1])}`);
  else if (cur) console.log(`  ${yellow("●")} unknown login ${dim(mask(cur))} ${dim("(run `cvx add` to name it)")}`);
  else console.log(`  ${dim("(not logged in)")}`);

  const link = resolveLink(process.cwd());
  console.log(bold("\nThis directory:"));
  if (link)
    console.log(
      `  linked to ${bold(link.account)}${
        link.path !== canon(process.cwd()) ? dim(`  (via ${shortPath(link.path)})`) : ""
      }`,
    );
  else console.log(dim("  not linked"));
}

function cmdAccounts() {
  const accounts = readAccounts();
  const entries = Object.entries(accounts);
  if (!entries.length) return console.log(dim("No accounts yet. Run `cvx login <name>` or `cvx add`."));
  const cur = currentConvexToken();
  console.log(bold("Accounts:"));
  for (const [name, acc] of entries) {
    const dot = acc.token === cur ? green("●") : dim("○");
    console.log(`  ${dot} ${bold(name.padEnd(14))} ${teamLabel(acc)} ${dim(mask(acc.token))}`);
  }
}

function cmdLs() {
  const links = readLinks();
  const entries = Object.entries(links);
  if (!entries.length) return console.log(dim("No projects linked yet. Run `cvx link <account>` in a project."));
  const here = canon(process.cwd());
  console.log(bold("Linked projects:"));
  for (const [path, account] of entries.sort()) {
    const marker = path === here ? cyan("→") : " ";
    console.log(`  ${marker} ${bold(account.padEnd(14))} ${shortPath(path)}`);
  }
}

function cmdWhich(args: string[]) {
  const link = resolveLink(args[0] ?? process.cwd());
  if (!link) {
    console.log("");
    process.exit(1);
  }
  console.log(link.account);
}

const HOOK = `
# --- convex-switch ---------------------------------------------------------
# Auto-activate the linked Convex account when you cd into a project.
_convex_switch_hook() { command cvx activate -q 2>/dev/null }
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook chpwd _convex_switch_hook
_convex_switch_hook   # run once for the current directory
# --- end convex-switch -----------------------------------------------------
`.trimStart();

function cmdHook(args: string[]) {
  const flags = parseFlags(args);
  if (flags.install) {
    const rc = join(HOME, ".zshrc");
    const body = existsSync(rc) ? readFileSync(rc, "utf8") : "";
    if (body.includes("convex-switch")) {
      console.log(yellow("Hook already present in ~/.zshrc — nothing to do."));
      return;
    }
    appendFileSync(rc, "\n" + HOOK);
    console.log(`${green("✓")} Added hook to ${cyan("~/.zshrc")}.`);
    console.log(dim("  Open a new terminal (or run `source ~/.zshrc`) to activate it."));
    return;
  }
  // Print for manual install / other shells.
  process.stdout.write(HOOK);
}

function help() {
  console.log(`${bold("cvx")} — switch Convex accounts per project, automatically

${bold("Setup (one-time per account)")}
  npx convex login              log into an account in your browser
  cvx add [name]                store the current login as <name> (verified)
  cvx login <name>              do both: login, then store as <name>

${bold("Wire projects to accounts")}
  cvx link <account> [path]     link a project dir (default: cwd) to an account
  cvx unlink [path]             remove a link
  cvx hook --install            add the cd-hook to ~/.zshrc (do this once)

${bold("Everyday")}
  cd <project> && bun run dev   the linked account is activated automatically
  cvx status                    show active account + this dir's link
  cvx accounts                  list stored accounts
  cvx ls                        list linked projects
  cvx activate [-q]             activate this dir's account (the hook calls this)

${bold("Manage")}
  cvx rm <account>              forget an account (and its links)
  cvx which [path]              print the account name for a dir (scripting)

Vault: ${cyan("~/.convex-switch/")}  (chmod 600, never in your projects)
`);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shortPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

/** Canonical absolute path (resolves symlinks like /tmp -> /private/tmp). */
function canon(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs; // path may not exist yet; fall back to normalized absolute
  }
}

function parseFlags(args: string[]): { _: string[]; [k: string]: any } {
  const out: { _: string[]; [k: string]: any } = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) out[ch] = true;
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureVault();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "add":
      return cmdAdd(rest);
    case "login":
      return cmdLogin(rest);
    case "link":
      return cmdLink(rest);
    case "unlink":
      return cmdUnlink(rest);
    case "rm":
    case "remove":
      return cmdRm(rest);
    case "activate":
    case "use":
      return cmdActivate(rest);
    case "status":
      return cmdStatus();
    case "accounts":
      return cmdAccounts();
    case "ls":
    case "list":
      return cmdLs();
    case "which":
      return cmdWhich(rest);
    case "hook":
      return cmdHook(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return help();
    default:
      die(`Unknown command: ${cmd}\nRun ${bold("cvx help")}.`);
  }
}

main().catch((e) => die(String(e?.stack ?? e)));
