/**
 * ui — everything the user sees: ANSI colors, the logo banner, the first-run
 * welcome, and the help screen. Pure presentation, no fs/network.
 */

import { HOME, VERSION, VAULT } from "./store";
import type { Account } from "./store";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = (s: string) => c("1", s);
export const dim = (s: string) => c("2", s);
export const green = (s: string) => c("32", s);
export const yellow = (s: string) => c("33", s);
export const red = (s: string) => c("31", s);
export const cyan = (s: string) => c("36", s);
/** 256-color foreground, for the banner gradient. */
const g = (n: number, s: string) => c(`38;5;${n}`, s);

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
// cyan → blue gradient, top to bottom
const SHADES = [51, 45, 39, 33, 27, 26];

export function banner(): string {
  const art = LOGO.map((line, i) => "  " + g(SHADES[i], line)).join("\n");
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
  cvx welcome                   show the welcome screen again
  cvx version                   print the version

Vault: ${cyan(shortVault())}  ${dim("(chmod 600, never in your projects)")}
`);
}

function shortVault() {
  return VAULT.startsWith(HOME) ? "~" + VAULT.slice(HOME.length) : VAULT;
}
