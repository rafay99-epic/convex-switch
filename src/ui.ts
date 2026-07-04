/**
 * ui — everything the user sees: ANSI colors, the logo banner, the first-run
 * welcome, and the help screen. Pure presentation, no fs/network.
 */

import { HOME, VERSION, VAULT } from "./store";
import type { Account } from "./store";
import { fg256, bold, dim, green, yellow, red, cyan, BANNER_GRADIENT } from "./colors";

// Re-export the palette so the rest of the app can import colors from "./ui".
export { c, bold, dim, green, yellow, red, cyan, blue, magenta, fg256 } from "./colors";

export function die(msg: string): never {
  console.error(red("✗ ") + msg);
  process.exit(1);
}

export function mask(token: string): string {
  return token.length <= 10
    ? "•".repeat(token.length)
    : token.slice(0, 6) + "…" + token.slice(-4);
}

export function teamLabel(acc: Account): string {
  if (!acc.teams.length) return dim("(unverified)");
  return dim(acc.teams.map((t) => t.slug).join(", "));
}

// --- The logo ---------------------------------------------------------------

const LOGO = [
  " ██████╗██╗   ██╗██╗  ██╗",
  "██╔════╝██║   ██║╚██╗██╔╝",
  "██║     ██║   ██║ ╚███╔╝ ",
  "██║     ╚██╗ ██╔╝ ██╔██╗ ",
  "╚██████╗ ╚████╔╝ ██╔╝ ██╗",
  " ╚═════╝  ╚═══╝  ╚═╝  ╚═╝ ",
];
export function banner(): string {
  const art = LOGO.map((line, i) => "  " + fg256(BANNER_GRADIENT[i], line)).join("\n");
  return `\n${art}\n  ${dim("convex-switch")} ${dim("v" + VERSION)} ${dim(
    "· one terminal, every Convex account",
  )}\n`;
}

// --- First-run welcome ------------------------------------------------------

export function welcome(): void {
  console.log(banner());
  console.log(`  ${bold("Welcome!")} Run all your Convex accounts across projects at once —
  no login/logout churn, no deploy keys, no tokens in your repos.

  ${bold("Get started")} ${dim("(one time)")}
    ${cyan("1")}  ${bold("cvx login <name>")}     ${dim("sign into an account and name it")}
    ${cyan("2")}  ${bold("cvx link <account>")}   ${dim("bind the current project to it")}
    ${cyan("3")}  ${bold("cvx hook --install")}   ${dim("auto-switch when you cd (adds a zsh hook)")}

  Then just ${bold("cd")} into a project and run your dev server — the right
  account is already active.

  ${dim("All commands:")} ${bold("cvx help")}   ${dim("·")}   ${dim("Manual:")} ${bold("man cvx")}
`);
}

// --- Help -------------------------------------------------------------------

export function help(): void {
  console.log(banner());
  console.log(`  ${dim("switch Convex accounts per project, automatically")}

${bold("Setup")} ${dim("(one-time per account)")}
  npx convex login              log into an account in your browser
  cvx add [name]                store the current login as <name> (verified)
  cvx login <name>              do both: login, then store as <name>
  cvx refresh <account>         re-authenticate an account (refresh its token)

${bold("Wire projects to accounts")}
  cvx link <account> [path]     link a project dir (default: cwd) to an account
  cvx unlink [path]             remove a link
  cvx hook --install            add the auto-switch hook (zsh/bash/fish/nu/pwsh)
  cvx completions <shell>       print a shell completion script

${bold("Everyday")}
  cd <project> && bun run dev   the linked account is activated automatically
  cvx use                       activate — or pick an account if unlinked
  cvx run <account> -- <cmd>    run one command as <account> (no global change)
  cvx open                      open the Convex dashboard for this project
  cvx status [--json]           show active account + this dir's link
  cvx accounts                  list stored accounts
  cvx ls                        list linked projects

${bold("Manage")}
  cvx rename <old> <new>        rename an account, keep its links
  cvx rm <account>              forget an account (and its links)
  cvx which [path]              print the account name for a dir (scripting)
  cvx prompt                    print the active account (for a shell prompt)
  cvx keychain <status|…>       store tokens in the OS keychain
  cvx doctor                    check setup + token health
  cvx welcome · version         the welcome screen · the version

Vault: ${cyan(shortVault())}  ${dim("(chmod 600, never in your projects)")}
`);
}

function shortVault() {
  return VAULT.startsWith(HOME) ? "~" + VAULT.slice(HOME.length) : VAULT;
}
