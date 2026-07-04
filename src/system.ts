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
