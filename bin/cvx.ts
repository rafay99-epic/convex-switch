#!/usr/bin/env bun
/**
 * convex-switch (cvx) — bind Convex accounts to projects and auto-activate the
 * right one when you cd into a project. No deploy keys, no tokens in project
 * files. It swaps the single global ~/.convex/config.json, which is the one
 * place the Convex CLI reads your account from.
 *
 * This file is just the entry point + dispatch. Logic lives in src/:
 *   store.ts     data layer (vault, config swap, verify, paths)
 *   ui.ts        colors, banner, welcome, help
 *   commands.ts  one function per subcommand
 *   args.ts      flag parsing
 */

import { ensureVault, isFirstRun, markWelcomed } from "../src/store";
import { die, help, welcome, bold } from "../src/ui";
import {
  cmdAdd,
  cmdLogin,
  cmdLink,
  cmdUnlink,
  cmdRm,
  cmdActivate,
  cmdStatus,
  cmdAccounts,
  cmdLs,
  cmdWhich,
  cmdVersion,
  cmdDoctor,
  cmdHook,
} from "../src/commands";

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
    case "doctor":
      return cmdDoctor();
    case "welcome":
      return welcome();
    case "version":
    case "-v":
    case "--version":
      return cmdVersion();
    case "help":
    case "-h":
    case "--help":
      return help();
    case undefined:
      // Bare `cvx`: greet on the very first run, otherwise show help.
      if (isFirstRun()) {
        markWelcomed();
        return welcome();
      }
      return help();
    default:
      die(`Unknown command: ${cmd}\nRun ${bold("cvx help")}.`);
  }
}

main().catch((e) => {
  // Clean one-line error for users; full stack only when CVX_DEBUG is set.
  if (process.env.CVX_DEBUG) console.error(e?.stack ?? e);
  die(e?.message ?? String(e));
});
