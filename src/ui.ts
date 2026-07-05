/**
 * ui — everything the user sees: ANSI colors, the gradient logo, Vex the
 * account chameleon, the first-run welcome, and the help screen. Pure
 * presentation, no fs/network.
 */

import { VERSION, VAULT, shortPath } from "./store";
import type { Account } from "./store";
import {
  bold,
  dim,
  green,
  yellow,
  red,
  cyan,
  fg256,
  brandLine,
  accountColorCode,
} from "./colors";

// Re-export the palette so the rest of the app can import colors from "./ui".
export { bold, dim, green, yellow, red, cyan, accountColor } from "./colors";

export function die(msg: string): never {
  console.error(red("✗ ") + msg);
  process.exit(1);
}

/**
 * Prompt without echoing (passphrases). Scripts should prefer the
 * CVX_PASSPHRASE env var; callers check it before prompting.
 */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY)
    die("This prompt needs a terminal. In scripts, set CVX_PASSPHRASE instead.");
  process.stdout.write(question);
  const stdin = process.stdin;
  return await new Promise((resolve) => {
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\x03") {
          // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\x7f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function teamLabel(acc: Account): string {
  if (!acc.teams.length) return dim("(unverified)");
  return dim(acc.teams.map((t) => t.slug).join(", "));
}

// --- The logo (Convex-brand gradient: yellow → red → purple) -----------------

const LOGO = [
  " ██████╗██╗   ██╗██╗  ██╗",
  "██╔════╝██║   ██║╚██╗██╔╝",
  "██║     ██║   ██║ ╚███╔╝ ",
  "██║     ╚██╗ ██╔╝ ██╔██╗ ",
  "╚██████╗ ╚████╔╝ ██╔╝ ██╗",
  " ╚═════╝  ╚═══╝  ╚═╝  ╚═╝ ",
];

export function banner(): string {
  const art = LOGO.map((line, i) => "  " + brandLine(line, i, LOGO.length)).join("\n");
  return `\n${art}\n  ${dim("convex-switch")} ${dim("v" + VERSION)} ${dim(
    "· one terminal, every Convex account",
  )}\n`;
}

// --- Vex, the account chameleon ----------------------------------------------
// A chameleon changes color to match its surroundings; cvx changes your
// account to match your project. Vex tints herself with the ACTIVE account's
// color, so `cvx status` tells you where you are before you read a word.

const VEX = [
  "    __.--.__",
  "  .'  o     '-._",
  "  \\             '-.___,",
  "   \\   __    __      _)",
  "    `-'  `--'  `---'(@",
];

const VEX_DEFAULT = 114; // resting chameleon green

/** Vex, tinted. Pass an account name to dress her in that account's color. */
export function mascot(accountName?: string | null): string {
  const code = accountName ? accountColorCode(accountName) : VEX_DEFAULT;
  return VEX.map((l) => "  " + fg256(code, l)).join("\n");
}

/** One-line cameo for small moments (doctor's all-clear). */
export function mascotWink(): string {
  return dim("~ Vex approves ") + fg256(VEX_DEFAULT, "(o‿<)@") + dim(" ~");
}

// --- First-run welcome ------------------------------------------------------

export function welcome(): void {
  console.log(banner());
  console.log(mascot() + "\n");
  console.log(`  ${bold("Welcome!")} ${dim("This is Vex — she turns the color of whatever account is active.")}
  Run all your Convex accounts across projects at once —
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

const h = (s: string) => bold(cyan(s));

export function help(): void {
  console.log(banner());
  console.log(`  ${dim("switch Convex accounts per project, automatically")}

${h("Setup")} ${dim("(one-time per account)")}
  npx convex login              log into an account in your browser
  cvx add [name]                store the current login as <name> (verified)
  cvx login <name>              do both: login, then store as <name>
  cvx refresh <account>         re-authenticate an account (refresh its token)

${h("Wire projects to accounts")}
  cvx link <account> [path]     link a project dir (default: cwd) to an account
  cvx unlink [path]             remove a link
  cvx hook --install            add the auto-switch hook (zsh/bash/fish/nu/pwsh)
  cvx completions <shell>       print a shell completion script

${h("Everyday")}
  cd <project> && bun run dev   the linked account is activated automatically
  cvx use [account]             activate by name — or pick one if unlinked
  cvx run <account> -- <cmd>    run one command as <account> (no global change)
  cvx open                      open the Convex dashboard for this project
  cvx status [--json]           show active account + this dir's link
  cvx accounts                  list stored accounts (+ last verified)
  cvx ls                        list linked projects

${h("Manage")}
  cvx rename <old> <new>        rename an account, keep its links
  cvx rm <account>              forget an account (and its links)
  cvx refresh --all             re-authenticate every stored account
  cvx which [path]              print the account name for a dir (scripting)
  cvx prompt                    print the active account (for a shell prompt)
  cvx keychain <status|…>       store tokens in the OS keychain
  cvx vault <status|…>          passphrase-encrypt stored tokens
  cvx export · import <file>    encrypted vault backup · restore (new machine)
  cvx doctor · upgrade          check setup + token health · check for updates
  cvx welcome · version         the welcome screen · the version

Vault: ${cyan(shortPath(VAULT))}  ${dim("(chmod 600, never in your projects)")}
`);
}
