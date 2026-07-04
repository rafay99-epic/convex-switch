/** commands — one function per subcommand. Glue between store + ui. */

import { existsSync, statSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

import { type Shell, hookFor, detectShell } from "./hooks";
import { hasCommand, isWindows } from "./system";

import {
  HOME,
  VERSION,
  type Team,
  readAccounts,
  writeAccounts,
  readLinks,
  writeLinks,
  currentConvexToken,
  setConvexToken,
  verifyToken,
  resolveLink,
  canon,
  shortPath,
} from "./store";
import { bold, dim, green, yellow, red, cyan, die, mask, teamLabel } from "./ui";
import { parseFlags } from "./args";

export async function cmdAdd(args: string[]) {
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

  accounts[name] = { token, teams, addedAt: new Date().toISOString() };
  writeAccounts(accounts);
  console.log(`${green("✓")} Stored account ${bold(name)} ${teamLabel(accounts[name])}`);
  console.log(dim(`  Next: cd into a project and run  ${bold(`cvx link ${name}`)}`));
}

export function cmdLogin(args: string[]) {
  const flags = parseFlags(args);
  const name = flags._[0];
  if (!name) die(`Usage: ${bold("cvx login <name>")}`);
  if (!hasCommand("npx"))
    die(
      `${bold("npx")} (Node.js) was not found on your PATH.\n` +
        `  Convex's CLI runs via npx — install Node from https://nodejs.org and retry.\n` +
        `  Already logged in elsewhere? Use ${bold(`cvx add ${name}`)} to store the current login.`,
    );
  // --force bypasses convex's "this device is already authorized" short-circuit,
  // so it actually opens the browser to sign into a *different* account.
  console.log(dim("Opening Convex login (forces a fresh browser sign-in)…"));
  const r = spawnSync("npx", ["--yes", "convex", "login", "--force"], {
    stdio: "inherit",
    shell: isWindows, // resolve npx.cmd on Windows
  });
  if (r.error) die(`Could not run convex login: ${r.error.message}`);
  if (r.status !== 0) die("convex login did not complete.");
  // Snapshot whatever token convex just wrote for the account you signed into.
  return cmdAdd([name, "--force"]);
}

export function cmdLink(args: string[]) {
  const flags = parseFlags(args);
  const account = flags._[0];
  if (!account) die(`Usage: ${bold("cvx link <account> [path]")}`);
  const accounts = readAccounts();
  if (!accounts[account])
    die(`Unknown account ${bold(account)}. Known: ${Object.keys(accounts).join(", ") || "(none)"}`);

  const input = flags._[1] ?? process.cwd();
  if (!existsSync(resolve(input))) die(`Path does not exist: ${input}`);
  if (!statSync(resolve(input)).isDirectory()) die(`Not a directory: ${input}`);
  const target = canon(input);

  const links = readLinks();
  links[target] = account;
  writeLinks(links);
  console.log(
    `${green("✓")} Linked ${bold(shortPath(target))} → ${bold(account)} ${teamLabel(accounts[account])}`,
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

export function cmdRm(args: string[]) {
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
  console.log(
    `${green("✓")} Removed account ${bold(name)}${removed ? dim(` (and ${removed} link(s))`) : ""}`,
  );
}

/**
 * activate — the workhorse the shell hook calls on every cd. Fast and quiet:
 * if the current dir maps to an account and that account isn't already active,
 * swap ~/.convex/config.json. Otherwise do nothing.
 */
export function cmdActivate(args: string[]) {
  const flags = parseFlags(args);
  const quiet = flags.q || flags.quiet;
  // The shell hook calls this on every cd — it must NEVER throw and break the
  // prompt. Any failure (corrupt vault, unreadable config, fs error) is
  // swallowed in quiet mode; surfaced briefly otherwise.
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
    if (currentConvexToken() === acc.token) {
      if (!quiet)
        console.log(`${green("●")} ${bold(link.account)} ${teamLabel(acc)} ${dim("(already active)")}`);
      return; // already correct — no write, no noise
    }
    setConvexToken(acc.token);
    // Print a concise switch notice even in quiet/hook mode so you see it on cd.
    console.log(`${cyan("⇄")} convex account → ${bold(link.account)} ${teamLabel(acc)}`);
  } catch (e) {
    if (!quiet) console.error(red("cvx: ") + (e as Error).message);
    // quiet (hook) mode: stay silent so the shell prompt is never disturbed
  }
}

export function cmdStatus() {
  const cur = currentConvexToken();
  const accounts = readAccounts();
  const active = Object.entries(accounts).find(([, a]) => a.token === cur);
  console.log(bold("Active convex account:"));
  if (active) console.log(`  ${green("●")} ${bold(active[0])} ${teamLabel(active[1])}`);
  else if (cur)
    console.log(`  ${yellow("●")} unknown login ${dim(mask(cur))} ${dim("(run `cvx add` to name it)")}`);
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

export function cmdAccounts() {
  const accounts = readAccounts();
  const entries = Object.entries(accounts);
  if (!entries.length)
    return console.log(dim("No accounts yet. Run `cvx login <name>` or `cvx add`."));
  const cur = currentConvexToken();
  console.log(bold("Accounts:"));
  for (const [name, acc] of entries) {
    const dot = acc.token === cur ? green("●") : dim("○");
    console.log(`  ${dot} ${bold(name.padEnd(14))} ${teamLabel(acc)} ${dim(mask(acc.token))}`);
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

export function cmdVersion() {
  console.log(VERSION);
}

/** Environment/health check: Node/npx, Convex login, vault, hook. */
export function cmdDoctor() {
  const mark = (b: boolean) => (b ? green("✓") : red("✗"));
  const warn = (b: boolean) => (b ? green("✓") : yellow("!"));
  let healthy = true;
  console.log(bold("cvx doctor") + "\n");

  // Node/npx — needed for `cvx login` (Convex's CLI runs via npx).
  const npx = hasCommand("npx");
  if (!npx) healthy = false;
  console.log(
    `  ${mark(npx)} node / npx        ${
      npx ? dim("available") : yellow("missing — needed for `cvx login`; install Node")
    }`,
  );

  // Has the user ever logged into Convex on this machine?
  const tok = currentConvexToken();
  console.log(
    `  ${warn(!!tok)} convex login      ${
      tok ? dim("~/.convex/config.json present") : yellow("none yet — run `cvx login <name>`")
    }`,
  );

  // Vault integrity.
  let vaultOk = true;
  let nAcc = 0;
  let nLink = 0;
  let accounts: Record<string, { token: string }> = {};
  try {
    accounts = readAccounts();
    nAcc = Object.keys(accounts).length;
    nLink = Object.keys(readLinks()).length;
  } catch (e) {
    vaultOk = false;
    healthy = false;
  }
  console.log(
    `  ${mark(vaultOk)} vault             ${
      vaultOk
        ? dim(`${nAcc} account(s), ${nLink} link(s)  ·  ~/.convex-switch`)
        : red("corrupted — see ~/.convex-switch")
    }`,
  );

  // Active account for this shell/dir.
  const active = vaultOk ? Object.entries(accounts).find(([, a]) => a.token === tok) : null;
  console.log(
    `  ${warn(!!active)} active account    ${active ? dim(active[0]) : dim("none active")}`,
  );

  // Shell hook installed?
  const rcs = [".zshrc", ".bashrc"].map((f) => join(HOME, f));
  const hooked = rcs.some((rc) => existsSync(rc) && readFileSync(rc, "utf8").includes("convex-switch"));
  console.log(
    `  ${warn(hooked)} shell hook        ${
      hooked ? dim("installed") : yellow("not installed — run `cvx hook --install`")
    }`,
  );

  console.log();
  console.log(healthy ? green("Everything looks good.") : yellow("Some checks need attention (see above)."));
  if (!healthy) process.exitCode = 1;
}

export function cmdHook(args: string[]) {
  const flags = parseFlags(args);
  const shell = (flags.shell as Shell) || detectShell();
  if (!["zsh", "bash", "powershell"].includes(shell))
    die(`Unknown shell ${bold(String(shell))}. Use --shell zsh|bash|powershell.`);
  const snippet = hookFor(shell);

  if (!flags.install) {
    process.stdout.write(snippet); // print for manual install
    return;
  }
  if (shell === "powershell") return installPwsh(snippet);

  // zsh / bash → append to the shell's rc file.
  const rc = join(HOME, shell === "bash" ? ".bashrc" : ".zshrc");
  const body = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  if (body.includes("convex-switch")) {
    console.log(yellow(`Hook already present in ${shortPath(rc)} — nothing to do.`));
    return;
  }
  appendFileSync(rc, "\n" + snippet);
  console.log(`${green("✓")} Added hook to ${cyan(shortPath(rc))}.`);
  console.log(dim(`  Open a new terminal (or run \`source ${shortPath(rc)}\`) to activate it.`));
}

/** Install into the PowerShell profile — ask PowerShell itself where it is. */
function installPwsh(snippet: string) {
  const ask = (exe: string) => {
    const r = spawnSync(exe, ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], {
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const profile = ask("pwsh") || ask("powershell");
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
