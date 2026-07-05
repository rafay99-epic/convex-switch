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
// Small, alive, expressive. A chameleon changes color to match its
// surroundings; cvx changes your account to match your project — so Vex wears
// the ACTIVE account's color and her face reacts to what's going on. Her tail
// is the little `~@` curl.

export type VexMood =
  | "happy"
  | "wink"
  | "blink"
  | "alarm"
  | "sleepy"
  | "curious"
  | "sad"
  | "excited";

const FACE: Record<VexMood, string> = {
  happy: "(◕‿◕)",
  wink: "(◕‿<)",
  blink: "(–‿–)",
  alarm: "(⊙︵⊙)",
  sleepy: "(–ᴗ–)ᶻ",
  curious: "(◕.◕)?",
  sad: "(◕︵◕)",
  excited: "(☆‿☆)",
};

const VEX_DEFAULT = 114; // resting chameleon green

/** Vex, one glyph tall. Pass an account name to dress her in its color. */
export function vex(mood: VexMood = "happy", accountName?: string | null): string {
  const code = accountName ? accountColorCode(accountName) : VEX_DEFAULT;
  return fg256(code, `${FACE[mood]}~@`);
}

/**
 * Vex appended to an action's result line — she reacts to what just happened.
 * Empty when piped, so scripted output stays byte-identical (output hygiene).
 */
export function vexTag(mood: VexMood = "happy", accountName?: string | null): string {
  return process.stdout.isTTY ? `  ${vex(mood, accountName)}` : "";
}

/**
 * Welcome intro: Vex blinks and shifts through a few account colors before
 * settling — chameleons gonna chameleon. TTY-only; pipes get one static line.
 */
async function vexIntro(): Promise<void> {
  const tag = dim("Vex — the account chameleon");
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    console.log(`  ${vex()}  ${tag}\n`);
    return;
  }
  const frames: Array<[VexMood, number]> = [
    ["blink", VEX_DEFAULT],
    ["happy", VEX_DEFAULT],
    ["happy", 45],
    ["happy", 213],
    ["happy", 214],
    ["happy", 141],
    ["blink", VEX_DEFAULT],
    ["happy", VEX_DEFAULT],
  ];
  process.stdout.write("\x1b[?25l");
  for (const [mood, code] of frames) {
    process.stdout.write(`\r  ${fg256(code, FACE[mood] + "~@")}  ${dim("…")}`);
    await new Promise((r) => setTimeout(r, 130));
  }
  process.stdout.write(`\r\x1b[2K\x1b[?25h  ${vex()}  ${tag}\n\n`);
}

// --- First-run welcome ------------------------------------------------------

export async function welcome(): Promise<void> {
  console.log(banner());
  await vexIntro();
  console.log(`  ${bold("Welcome!")} ${dim("Vex turns the color of whatever account is active.")}
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
  cvx scan [dir]                auto-discover projects and link them by team
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
  cvx doctor [--fix] · upgrade  check setup + token health (--fix repairs) · updates
  cvx welcome · version         the welcome screen · the version

Vault: ${cyan(shortPath(VAULT))}  ${dim("(chmod 600, never in your projects)")}
`);
}
