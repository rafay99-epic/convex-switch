/**
 * system — checks for external tools the CLI depends on. NOTE: `cvx` is a
 * Bun-compiled binary, so `process.versions.node` reflects the bundled runtime,
 * not the user's Node. Convex's own CLI runs via the user's `npx`, so we must
 * probe the real system PATH here — hence spawning, not process.versions.
 */

import { spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

/** True if `<cmd> --version` runs successfully from the system PATH. */
export function hasCommand(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ["--version"], {
      stdio: "ignore",
      shell: isWindows, // resolve npx.cmd / PATHEXT on Windows
      timeout: 8000,
    });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Quote ONE argument for a literal cmd.exe command line (cross-spawn's
 * escape.js, faithfully). We need this because a `.cmd`/`.bat` shim can only be
 * launched through `cmd.exe`, and cmd re-parses its command line — so any arg
 * with a space, quote, or shell metachar must be pre-escaped or it arrives
 * shredded.
 *
 * Two steps, exactly as cross-spawn does them:
 *  (a) CreateProcess argument rules: double every run of backslashes that
 *      precedes a `"` and escape that quote as `\"`; double a trailing run of
 *      backslashes (it will end up in front of the closing quote); wrap the
 *      whole thing in `"`.
 *  (b) cmd.exe shell escaping: prefix every cmd metacharacter — the wrapping
 *      quotes included — `( ) % ! ^ " < > & |` with `^` so cmd passes them
 *      through verbatim (we spawn with windowsVerbatimArguments: true).
 *
 * A token that is non-empty and free of whitespace and every cmd-significant
 * character is returned untouched, so common invocations stay readable. The
 * empty string is NOT safe (cmd would drop it), so it becomes `^"^"`.
 */
export function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&<>|^%!(),;=]/.test(arg)) return arg;

  // (a) escapeArgument — CreateProcess quoting.
  let s = arg.replace(/(\\*)"/g, '$1$1\\"'); // double backslashes, escape quote
  s = s.replace(/(\\*)$/, "$1$1"); // double a trailing backslash run
  s = `"${s}"`; // wrap

  // (b) escape cmd shell metacharacters (the quotes we just added included).
  s = s.replace(/([()%!^"<>&|])/g, "^$1");
  return s;
}

/**
 * Run a child process inheriting our stdio, the drop-in replacement for
 * cmdRun's spawn. The old `spawnSync(cmd, args, { shell: isWindows })` was
 * broken on Windows: with shell:true Node joins argv with spaces and cmd.exe
 * re-splits it, shredding any argument that contains a space or quote.
 *
 *  - POSIX: spawn directly, no shell — args pass through verbatim (unchanged).
 *  - Windows: resolve the executable via Bun.which.
 *      * `.cmd`/`.bat` shims (e.g. npx.cmd) are not executable images and can
 *        only run through cmd.exe, so we build ONE verbatim command line
 *        (each token quoted via quoteForCmd) and hand it to
 *        `cmd.exe /d /s /c "<line>"` with windowsVerbatimArguments so Node
 *        doesn't re-quote it. The outer `"…"` is what `/s` strips.
 *      * a real `.exe` / extensionless native binary skips the shell entirely,
 *        so its arguments arrive verbatim.
 *    A null from Bun.which falls back to the raw cmd, letting spawnSync raise
 *    ENOENT which cmdRun already reports as "Command not found".
 */
export function runInherit(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  if (!isWindows) {
    return spawnSync(cmd, args, { stdio: "inherit", env });
  }

  const resolved = Bun.which(cmd) ?? cmd;
  const lower = resolved.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const line = [resolved, ...args].map(quoteForCmd).join(" ");
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      stdio: "inherit",
      env,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(resolved, args, { stdio: "inherit", env });
}

/** Open a URL in the user's default browser. Returns false if it couldn't. */
export function openUrl(url: string): boolean {
  try {
    const r =
      process.platform === "darwin"
        ? spawnSync("open", [url], { stdio: "ignore" })
        : process.platform === "win32"
          ? spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore" })
          : spawnSync("xdg-open", [url], { stdio: "ignore" });
    return !r.error && (r.status === 0 || r.status === null);
  } catch {
    return false;
  }
}
