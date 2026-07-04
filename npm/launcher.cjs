#!/usr/bin/env node
"use strict";
/**
 * Launcher for the `convex-switch` npm package. The actual `cvx` binary is
 * shipped inside a per-platform package (convex-switch-<os>-<arch>) selected by
 * npm/bun/pnpm via `os`/`cpu`. This shim resolves that binary and execs it —
 * no postinstall, so it works even under `bun add -g` and `--ignore-scripts`.
 */
const { spawnSync } = require("child_process");

const target = `@rafay99/cvx-${process.platform}-${process.arch}`;
const binName = process.platform === "win32" ? "cvx.exe" : "cvx";

let binary;
try {
  binary = require.resolve(`${target}/bin/${binName}`);
} catch {
  console.error(
    `cvx: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.\n` +
      `If your platform is supported, reinstall without --no-optional.`,
  );
  process.exit(1);
}

const res = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (res.error) {
  console.error(res.error.message);
  process.exit(1);
}
// Propagate a signal death (Ctrl-C etc.) as a signal, not a generic failure.
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status === null ? 1 : res.status);
