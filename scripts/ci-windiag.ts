/**
 * TEMPORARY Windows CI diagnostic — remove before merge.
 * Probes command resolution and each cmd.exe spawn strategy so we can see
 * exactly what the runner does instead of guessing from assertion diffs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const show = (name: string, r: ReturnType<typeof spawnSync>) =>
  console.log(
    `${name}: status=${r.status} signal=${r.signal} error=${r.error ? (r.error as any).code ?? r.error.message : "none"} out=${JSON.stringify((r.stdout ?? "").toString().slice(0, 60))} err=${JSON.stringify((r.stderr ?? "").toString().slice(0, 120))}`,
  );

function resolveWindowsCommand(cmd: string): string {
  if (/[\\/]/.test(cmd)) return cmd;
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  const hasExt = /\.[^\\/.]+$/.test(cmd);
  const exts = hasExt ? [""] : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) for (const ext of exts) {
    const f = join(dir, cmd + ext);
    if (existsSync(f)) return f;
  }
  return cmd;
}

const resolved = resolveWindowsCommand("npx");
console.log("resolved npx =", resolved, "| exists:", existsSync(resolved));

// A: current strategy — one verbatim line through cmd /d /s /c
const q = (s: string) => (/[\s"&<>|^%!(),;=]/.test(s) || !s ? `^"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}^"`.replace(/([()%!<>&|])/g, "^$1") : s);
const lineA = [resolved, "--version"].map(q).join(" ");
console.log("lineA =", JSON.stringify(lineA));
show("A verbatim /s /c", spawnSync("cmd.exe", ["/d", "/s", "/c", `"${lineA}"`], { encoding: "utf8", windowsVerbatimArguments: true, timeout: 60000 }));

// B: cmd /c with plain array args (node quotes them itself)
show("B array /c      ", spawnSync("cmd.exe", ["/c", resolved, "--version"], { encoding: "utf8", timeout: 60000 }));

// C: shell:true with the RESOLVED full path
show("C shell resolved", spawnSync(resolved, ["--version"], { encoding: "utf8", shell: true, timeout: 60000 }));

// D: spaced arg through B
show("D array spaced  ", spawnSync("cmd.exe", ["/c", process.execPath, "-e", "console.log('a b  c')"], { encoding: "utf8", timeout: 60000 }));

// E: doctor timing, twice
const CVX = join(import.meta.dir, "..", "bin", "cvx.ts");
for (const i of [1, 2]) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [CVX, "doctor", "--no-tokens"], {
    encoding: "utf8",
    env: { ...process.env, CVX_HOME: join(process.env.RUNNER_TEMP ?? "/tmp", "cvx-diag-home"), NO_COLOR: "1" },
    timeout: 60000,
  });
  console.log(`E doctor#${i}: ${Date.now() - t}ms status=${r.status} signal=${r.signal} errTail=${JSON.stringify((r.stderr ?? "").slice(-200))}`);
}
