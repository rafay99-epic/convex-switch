/**
 * End-to-end tests: spawn the real CLI (`bun bin/cvx.ts`) against a throwaway
 * CVX_HOME. Covers every command's observable behavior except the three flows
 * that can't run headless/sandboxed: real `login`/`refresh` (browser), the
 * interactive migration prompt (needs a PTY), and `keychain enable` (per-user
 * OS keychain). See CLAUDE.md "Safety rules".
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Gates the handful of assertions/flows that are genuinely POSIX-only (file
// modes, shell stubs) so the rest of the suite still runs — and is asserted
// on — under Windows CI.
const WIN = process.platform === "win32";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "cvx.ts");
const HOME = mkdtempSync(join(tmpdir(), "cvx-e2e."));
const PROJ = join(HOME, "proj");
const NESTED = join(PROJ, "nested");

const ACCOUNTS = join(HOME, ".convex-switch", "accounts.json");
const LINKS = join(HOME, ".convex-switch", "links.json");
const CONFIG = join(HOME, ".convex-switch", "config.json");
const ACTIVE = join(HOME, ".convex-switch", "active");
const CONVEX_CFG = join(HOME, ".convex", "config.json");

// A stub opener (both names, so tests pass on macOS and Linux) that fails,
// making `cvx open` fall back to printing the URL instead of launching a browser.
const STUB_BIN = join(HOME, "stub-bin");

function cvx(
  args: string[],
  opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
) {
  // process.execPath = the running bun binary — immune to PATH overrides below.
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    input: opts.stdin ?? "", // piped stdin → never a TTY
    env: { ...process.env, CVX_HOME: HOME, NO_COLOR: "1", ...opts.env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", all: (r.stdout ?? "") + (r.stderr ?? "") };
}

function seedAccounts() {
  writeFileSync(
    ACCOUNTS,
    JSON.stringify({
      work: { token: "tok-work-AAA", teams: [{ slug: "wt", name: "WT" }], addedAt: "2026-01-01" },
      personal: { token: "tok-pers-BBB", teams: [{ slug: "me", name: "Me" }], addedAt: "2026-01-01" },
    }),
  );
  writeFileSync(LINKS, "{}");
  writeFileSync(CONFIG, JSON.stringify({ schemaVersion: 2 }));
}

beforeAll(() => {
  mkdirSync(NESTED, { recursive: true });
  mkdirSync(STUB_BIN, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(STUB_BIN, name), "#!/bin/sh\nexit 3\n");
    chmodSync(join(STUB_BIN, name), 0o755);
  }
  cvx(["version"]); // first run creates the vault
});

describe("basics", () => {
  test("version prints the dev placeholder", () => {
    const r = cvx(["version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("0.0.0-dev");
  });
  test("help exits 0 and lists commands", () => {
    const r = cvx(["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("cvx link <account>");
  });
  test("unknown command exits 1", () => {
    const r = cvx(["nosuchcmd"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Unknown command");
  });
  // Unix file-mode bits (700/600) aren't meaningful on Windows — there's no
  // POSIX permission model to assert against there.
  test.skipIf(WIN)("vault dir is 700, files are 600", () => {
    expect(statSync(join(HOME, ".convex-switch")).mode & 0o777).toBe(0o700);
    expect(statSync(ACCOUNTS).mode & 0o777).toBe(0o600);
  });
});

describe("link / which / ls / unlink", () => {
  test("link, which, ls round-trip", () => {
    seedAccounts();
    expect(cvx(["link", "work", PROJ]).code).toBe(0);
    const w = cvx(["which", PROJ]);
    expect(w.code).toBe(0);
    expect(w.out.trim()).toBe("work");
    expect(cvx(["ls"]).out).toContain("work");
  });
  test("boolean flag before the account name does not swallow it", () => {
    expect(cvx(["link", "--force", "personal", NESTED]).code).toBe(0);
    expect(cvx(["which", NESTED]).out.trim()).toBe("personal");
  });
  test("which on an unlinked dir exits 1", () => {
    expect(cvx(["which", tmpdir()]).code).toBe(1);
  });
  test("linking an unknown account dies", () => {
    const r = cvx(["link", "ghost", PROJ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Unknown account");
  });
  test("unlink removes; second unlink dies", () => {
    const extra = join(HOME, "extra");
    mkdirSync(extra, { recursive: true });
    cvx(["link", "work", extra]);
    expect(cvx(["unlink", extra]).code).toBe(0);
    expect(cvx(["unlink", extra]).code).toBe(1);
  });
});

describe("activate / status / prompt / accounts", () => {
  test("activate swaps the global config and writes a fingerprinted marker", () => {
    seedAccounts();
    cvx(["link", "work", PROJ]);
    const r = cvx(["activate", PROJ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(CONVEX_CFG, "utf8")).accessToken).toBe("tok-work-AAA");
    const [name, fp] = readFileSync(ACTIVE, "utf8").split("\n");
    expect(name).toBe("work");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });
  test("re-activate reports already active", () => {
    expect(cvx(["activate", PROJ]).out).toContain("already active");
  });
  test("nested dir activates its own closer link", () => {
    cvx(["link", "personal", NESTED]);
    cvx(["activate", NESTED]);
    expect(JSON.parse(readFileSync(CONVEX_CFG, "utf8")).accessToken).toBe("tok-pers-BBB");
  });
  test("activate -q on an unlinked dir prints nothing", () => {
    const r = cvx(["activate", "-q", tmpdir()]);
    expect(r.code).toBe(0);
    expect(r.all.trim()).toBe("");
  });
  test("status --json reports active + link", () => {
    cvx(["activate", PROJ]);
    const s = JSON.parse(cvx(["status", "--json"], { cwd: PROJ }).out);
    expect(s.active).toBe("work");
    expect(s.linked).toBe("work");
    expect(s.loggedIn).toBe(true);
  });
  test("prompt prints the active account name", () => {
    expect(cvx(["prompt"]).out).toBe("work");
  });
  test("accounts lists all; --names is bare", () => {
    expect(cvx(["accounts"]).out).toContain("personal");
    expect(cvx(["accounts", "--names"]).out.trim().split("\n").sort()).toEqual(["personal", "work"]);
  });
});

describe("run", () => {
  test("passes the token via env and propagates the exit code", () => {
    seedAccounts();
    // Run the Bun binary itself instead of /bin/sh -c "..." — a platform-neutral
    // stand-in for "some child process" that works identically on Windows.
    // The inline script must contain NO SPACES: cmdRun spawns with shell:true
    // on Windows (to resolve .cmd shims), so cmd.exe re-splits joined args.
    const r = cvx([
      "run",
      "work",
      "--",
      process.execPath,
      "-e",
      "console.log('T='+process.env.CONVEX_OVERRIDE_ACCESS_TOKEN)",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("T=tok-work-AAA");
    expect(cvx(["run", "work", "--", process.execPath, "-e", "process.exit(7)"]).code).toBe(7);
  });
  test("errors: no command / unknown account", () => {
    expect(cvx(["run", "work"]).code).toBe(1);
    expect(cvx(["run", "ghost", "--", "echo", "hi"]).err).toContain("Unknown account");
  });
  test("arguments with spaces and quotes survive on every OS", () => {
    // The exact case the CI matrix caught: shell:true used to let cmd.exe
    // re-split spaced args on Windows. runInherit must deliver them verbatim.
    const r = cvx(["run", "work", "--", process.execPath, "-e", "console.log('a b  c')"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("a b  c");
    const q = cvx(["run", "work", "--", process.execPath, "-e", 'console.log("percent 100% & pipe |")']);
    expect(q.code).toBe(0);
    expect(q.out).toContain("percent 100% & pipe |");
  });
  test("resolves .cmd shims (npx) through the safe path", () => {
    // npx is npx.cmd on Windows — exercises runInherit's cmd.exe branch there.
    const r = cvx(["run", "work", "--", "npx", "--version"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^\d+\./);
  });
});

describe("rename / rm", () => {
  test("rename moves links and the active marker", () => {
    seedAccounts();
    cvx(["link", "work", PROJ]);
    cvx(["activate", PROJ]);
    const r = cvx(["rename", "work", "office"]);
    expect(r.code).toBe(0);
    expect(cvx(["which", PROJ]).out.trim()).toBe("office");
    expect(readFileSync(ACTIVE, "utf8").split("\n")[0]).toBe("office");
  });
  test("__proto__ is rejected and the vault is intact", () => {
    const r = cvx(["rename", "office", "__proto__"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Invalid account name");
    expect(Object.keys(JSON.parse(readFileSync(ACCOUNTS, "utf8")))).toContain("office");
  });
  test("rm deletes the account and its links", () => {
    cvx(["link", "personal", NESTED]);
    expect(cvx(["rm", "personal"]).code).toBe(0);
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).personal).toBeUndefined();
    // nested resolves up-tree to the parent link now
    expect(cvx(["which", NESTED]).out.trim()).toBe("office");
  });
});

describe("add — argument validation (no network on failure paths)", () => {
  test("--token without a value dies with usage", () => {
    seedAccounts();
    const r = cvx(["add", "foo", "--token"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--token needs a value");
  });
  test("--token followed by a flag is treated as missing", () => {
    expect(cvx(["add", "foo", "--token", "--force"]).err).toContain("--token needs a value");
  });
  test("a NEW invalid name dies before the network round-trip", () => {
    const r = cvx(["add", "_newbad", "--token", "x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Invalid account name");
  });
  test("an EXISTING legacy name is grandfathered past validation", () => {
    const accounts = JSON.parse(readFileSync(ACCOUNTS, "utf8"));
    accounts["_legacy"] = { token: "tok-legacy", teams: [], addedAt: "2025-01-01" };
    writeFileSync(ACCOUNTS, JSON.stringify(accounts));
    // Reaches token verification (network) — fails there, NOT on the name.
    const r = cvx(["add", "_legacy", "--token", "bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("Invalid account name");
  });
});

describe("migration", () => {
  test("legacy vault with accounts: non-TTY defers (no prompt, no stamp)", () => {
    seedAccounts();
    writeFileSync(CONFIG, "{}");
    const r = cvx(["ls"]);
    expect(r.code).toBe(0);
    expect(r.all).not.toContain("migrate");
    expect(readFileSync(CONFIG, "utf8").trim()).toBe("{}");
  });
  test("exempt commands never prompt on a legacy vault", () => {
    for (const args of [["activate", "-q"], ["which", PROJ], ["prompt"], ["accounts", "--names"]]) {
      expect(cvx(args).all).not.toContain("migrate");
    }
  });
  test("empty legacy vault stamps the schema silently", () => {
    writeFileSync(ACCOUNTS, "{}");
    writeFileSync(CONFIG, "{}");
    cvx(["ls"]);
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).schemaVersion).toBe(2);
  });
});

describe("corrupt vault", () => {
  test("clean one-line error, stack only with CVX_DEBUG", () => {
    seedAccounts();
    writeFileSync(ACCOUNTS, "{broken");
    const r = cvx(["accounts"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("corrupted");
    expect(r.err).not.toContain("at "); // no stack frames
    expect(cvx(["accounts"], { env: { CVX_DEBUG: "1" } }).err).toContain("at ");
    seedAccounts();
  });
  test("doctor distinguishes a corrupt links.json from the accounts vault", () => {
    writeFileSync(LINKS, "{broken");
    const r = cvx(["doctor", "--no-tokens"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("links.json corrupted");
    writeFileSync(LINKS, "{}");
  });
});

describe("doctor / completions / hook", () => {
  test("doctor --no-tokens runs offline and reports plain-file storage", () => {
    seedAccounts();
    const r = cvx(["doctor", "--no-tokens"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("plain file (chmod 600)");
  });
  test("completions exist for all four shells; nu gets a specific message", () => {
    for (const sh of ["zsh", "bash", "fish", "powershell"]) {
      const r = cvx(["completions", sh]);
      expect(r.code).toBe(0);
      expect(r.out.length).toBeGreaterThan(100);
    }
    expect(cvx(["completions", "nu"]).err).toContain("Nushell");
    expect(cvx(["completions", "klingon"]).code).toBe(1);
  });
  test("hook prints a marked snippet for every shell", () => {
    for (const sh of ["zsh", "bash", "fish", "nu", "powershell"]) {
      const r = cvx(["hook", "--shell", sh]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("convex-switch");
      expect(r.out).toContain("cvx activate -q");
    }
    expect(cvx(["hook", "--shell", "klingon"]).code).toBe(1);
  });
  test("hook --install writes the sandbox rc once, idempotently", () => {
    expect(cvx(["hook", "--install", "--shell", "zsh"]).code).toBe(0);
    expect(cvx(["hook", "--install", "--shell", "zsh"]).out).toContain("already present");
    const rc = readFileSync(join(HOME, ".zshrc"), "utf8");
    expect(rc.split("# --- convex-switch").length - 1).toBe(1);
    // doctor now sees the hook
    expect(cvx(["doctor", "--no-tokens"]).out).toMatch(/shell hook\s+installed/);
  });
});

describe("use by name", () => {
  test("cvx use <account> activates globally from anywhere", () => {
    seedAccounts();
    const r = cvx(["use", "personal"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(CONVEX_CFG, "utf8")).accessToken).toBe("tok-pers-BBB");
    expect(readFileSync(ACTIVE, "utf8").split("\n")[0]).toBe("personal");
  });
  test("an unknown name in an unlinked dir falls through to the non-TTY error", () => {
    const r = cvx(["use", "ghost"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("isn't linked");
  });
});

describe("team mismatch guard", () => {
  test("warns loudly — even in quiet hook mode — when the project team isn't the account's", () => {
    seedAccounts(); // work's only team slug is "wt"
    cvx(["link", "work", PROJ]);
    writeFileSync(
      join(PROJ, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:happy-otter-123 # team: other-team, project: x\n",
    );
    const r = cvx(["activate", PROJ]);
    expect(r.out).toContain("team mismatch");
    expect(r.out).toContain("other-team");
    expect(cvx(["activate", "-q", PROJ]).out).toContain("team mismatch");
    // status shows it too
    expect(cvx(["status"], { cwd: PROJ }).out).toContain("team mismatch");
  });
  test("silent when the team matches or there is no team note", () => {
    writeFileSync(
      join(PROJ, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:happy-otter-123 # team: wt, project: x\n",
    );
    expect(cvx(["activate", PROJ]).out).not.toContain("team mismatch");
    writeFileSync(join(PROJ, ".env.local"), "CONVEX_DEPLOYMENT=dev:happy-otter-123\n");
    expect(cvx(["activate", PROJ]).out).not.toContain("team mismatch");
    rmSync(join(PROJ, ".env.local"), { force: true });
  });
});

describe("vault (passphrase-encrypted tokens)", () => {
  const env = { CVX_PASSPHRASE: "e2e-vault-passphrase" };
  test("encrypt replaces plaintext tokens with pw blobs", () => {
    seedAccounts();
    const r = cvx(["vault", "encrypt"], { env });
    expect(r.code).toBe(0);
    const raw = readFileSync(ACCOUNTS, "utf8");
    expect(raw).not.toContain("tok-work-AAA");
    expect(JSON.parse(raw).work.pw).toBeDefined();
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).storage).toBe("passphrase");
  });
  test("activate works while unlocked", () => {
    cvx(["link", "work", PROJ]);
    expect(cvx(["activate", PROJ]).code).toBe(0);
    expect(JSON.parse(readFileSync(CONVEX_CFG, "utf8")).accessToken).toBe("tok-work-AAA");
  });
  test("locked: activate prints the unlock hint even in quiet mode", () => {
    expect(cvx(["vault", "lock"]).code).toBe(0);
    writeFileSync(CONVEX_CFG, "{}\n"); // no fast-path masking
    expect(cvx(["activate", "-q", PROJ]).out).toContain("vault locked");
  });
  test("wrong passphrase fails; the right one unlocks", () => {
    expect(cvx(["vault", "unlock"], { env: { CVX_PASSPHRASE: "wrong-passphrase" } }).code).toBe(1);
    expect(cvx(["vault", "unlock"], { env }).code).toBe(0);
    expect(cvx(["activate", PROJ]).code).toBe(0);
    expect(JSON.parse(readFileSync(CONVEX_CFG, "utf8")).accessToken).toBe("tok-work-AAA");
  });
  test("decrypt restores plaintext and removes the vault metadata", () => {
    expect(cvx(["vault", "decrypt"], { env }).code).toBe(0);
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).work.token).toBe("tok-work-AAA");
    expect(existsSync(join(HOME, ".convex-switch", "vault.json"))).toBe(false);
    expect(JSON.parse(readFileSync(CONFIG, "utf8")).storage).toBe("file");
  });
});

describe("export / import via the CLI", () => {
  const env = { CVX_PASSPHRASE: "e2e-export-pass" };
  const file = join(HOME, "backup.export");
  test("round-trip restores accounts and links", () => {
    seedAccounts();
    cvx(["link", "work", PROJ]);
    expect(cvx(["export", file], { env }).code).toBe(0);
    writeFileSync(ACCOUNTS, "{}");
    writeFileSync(LINKS, "{}");
    expect(cvx(["import", file], { env }).code).toBe(0);
    const accs = JSON.parse(readFileSync(ACCOUNTS, "utf8"));
    expect(accs.work.token).toBe("tok-work-AAA");
    expect(cvx(["which", PROJ]).out.trim()).toBe("work");
  });
  test("wrong passphrase on import dies cleanly", () => {
    const r = cvx(["import", file], { env: { CVX_PASSPHRASE: "wrong-pass-123" } });
    expect(r.code).toBe(1);
    expect(r.err).toContain("wrong passphrase");
  });
});

describe("refresh --all / help", () => {
  test("refresh --all with an empty vault dies before any browser opens", () => {
    writeFileSync(ACCOUNTS, "{}");
    const r = cvx(["refresh", "--all"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No accounts");
    seedAccounts();
  });
  test("help lists the new commands", () => {
    const out = cvx(["help"]).out;
    for (const s of ["cvx use [account]", "cvx vault", "cvx export", "refresh --all", "upgrade"])
      expect(out).toContain(s);
  });
});

// Windows opens URLs via `cmd /c start`, not an `open`/`xdg-open` binary on
// PATH — stubbing cmd.exe itself isn't safe (it's used for far more than
// launching a browser), so this whole flow is untestable headlessly there.
describe("undo", () => {
  test("rm (piped: no confirmation) then undo --yes restores the account and links", () => {
    seedAccounts();
    cvx(["link", "work", PROJ]);
    expect(cvx(["rm", "work"]).code).toBe(0); // piped stdin → no prompt, removes
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).work).toBeUndefined();
    const r = cvx(["undo", "--yes"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).work.token).toBe("tok-work-AAA");
    expect(cvx(["which", PROJ]).out.trim()).toBe("work");
  });
  test("undo of an undo reverses the restore", () => {
    cvx(["rm", "work"]);
    cvx(["undo", "--yes"]); // work back
    cvx(["undo", "--yes"]); // reverse the restore → work gone again
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).work).toBeUndefined();
    cvx(["undo", "--yes"]); // and back once more
    expect(JSON.parse(readFileSync(ACCOUNTS, "utf8")).work).toBeDefined();
  });
  test("--list shows labeled history; piped undo without --yes refuses", () => {
    const l = cvx(["undo", "--list"]);
    expect(l.code).toBe(0);
    expect(l.out).toContain("before");
    const r = cvx(["undo"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--yes");
  });
  test("history is capped at 5 snapshots", () => {
    seedAccounts();
    for (let i = 0; i < 8; i++) cvx(["link", "work", PROJ]); // 8 mutating commands
    const { readdirSync } = require("node:fs");
    const n = readdirSync(join(HOME, ".convex-switch", "backups")).filter((f: string) =>
      f.endsWith(".json"),
    ).length;
    expect(n).toBeLessThanOrEqual(5);
  });
  test("vault encrypt purges the undo history (it held plaintext tokens)", () => {
    seedAccounts();
    cvx(["link", "work", PROJ]); // ensure at least one snapshot exists
    expect(cvx(["undo", "--list"]).out).toContain("before");
    expect(cvx(["vault", "encrypt"], { env: { CVX_PASSPHRASE: "purge-check-pass" } }).code).toBe(0);
    expect(cvx(["undo", "--list"]).out).toContain("No undo history");
    cvx(["vault", "decrypt"], { env: { CVX_PASSPHRASE: "purge-check-pass" } });
  });
});

describe("prompt variants", () => {
  test("--starship prints a paste-ready config block", () => {
    const r = cvx(["prompt", "--starship"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[custom.cvx]");
    expect(r.out).toContain('command = "cvx prompt"');
  });
  test("--color emits raw ANSI even when piped (explicit opt-in exception)", () => {
    seedAccounts();
    cvx(["use", "work"]);
    const r = cvx(["prompt", "--color"]);
    expect(r.out).toContain("\x1b[1;38;5;");
    expect(r.out).toContain("work");
    // bare prompt stays undecorated
    expect(cvx(["prompt"]).out).toBe("work");
  });
});

describe.skipIf(WIN)("open (stubbed opener — never launches a browser)", () => {
  const env = { PATH: `${STUB_BIN}${delimiter}/usr/bin${delimiter}/bin` };
  test("prints the deployment URL when the opener fails", () => {
    writeFileSync(join(PROJ, ".env.local"), "CONVEX_DEPLOYMENT=dev:happy-otter-123\n");
    const r = cvx(["open", PROJ], { env });
    expect(r.code).toBe(1);
    expect(r.err).toContain("https://dashboard.convex.dev/d/happy-otter-123");
  });
  test("rejects a malicious deployment value (injection guard)", () => {
    writeFileSync(join(PROJ, ".env.local"), "CONVEX_DEPLOYMENT=dev:evil&calc\n");
    const r = cvx(["open", PROJ], { env });
    expect(r.all).not.toContain("evil");
    expect(r.err).toContain("https://dashboard.convex.dev");
  });
});

describe("scan (auto-link discovery)", () => {
  const scanroot = join(HOME, "scanroot");
  const A = join(scanroot, "a");
  const B = join(scanroot, "b");
  const C = join(scanroot, "c");
  beforeAll(() => {
    for (const d of [A, B, C]) mkdirSync(d, { recursive: true });
    // a's team "wt" matches the seeded "work" account; b's "nobody" matches none.
    writeFileSync(join(A, ".env.local"), "CONVEX_DEPLOYMENT=dev:x-1 # team: wt, project: p\n");
    writeFileSync(join(B, ".env.local"), "CONVEX_DEPLOYMENT=dev:y-1 # team: nobody\n");
    // c has no .env.local — not a project.
  });

  test("--yes links a→work, reports b as unmatched, ignores c", () => {
    seedAccounts();
    const r = cvx(["scan", scanroot, "--yes"]);
    expect(r.code).toBe(0);
    expect(cvx(["which", A]).out.trim()).toBe("work");
    expect(r.all).toContain("nobody");
    expect(cvx(["which", B]).code).toBe(1); // b never linked
  });

  test("second run counts a as already-linked and creates nothing new", () => {
    const r = cvx(["scan", scanroot, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already 1");
    expect(cvx(["which", A]).out.trim()).toBe("work");
  });

  test("piped scan without --yes exits 1 and links nothing", () => {
    cvx(["unlink", A]); // a fresh proposal to refuse
    const r = cvx(["scan", scanroot]);
    expect(r.code).toBe(1);
    expect(cvx(["which", A]).code).toBe(1); // still unlinked
  });

  test("conflict: an existing different link is kept, never overwritten", () => {
    cvx(["link", "personal", A]);
    const r = cvx(["scan", scanroot, "--yes"]);
    expect(r.code).toBe(0);
    expect(cvx(["which", A]).out.trim()).toBe("personal");
  });

  test("no accounts stored dies with guidance", () => {
    writeFileSync(ACCOUNTS, "{}");
    const r = cvx(["scan", scanroot]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("No accounts");
    seedAccounts();
  });
});

describe("doctor --fix", () => {
  const zshrc = join(HOME, ".zshrc");
  const deadDir = join(HOME, "gone-proj");

  // detectShell() ignores $SHELL and always returns "powershell" on Windows,
  // which would route this through installPwsh() — spawning real pwsh and
  // appending to the CI runner's actual $PROFILE instead of anything sandboxed.
  test.skipIf(WIN)("prunes dead links and installs the missing shell hook", () => {
    seedAccounts();
    rmSync(zshrc, { force: true }); // start with the hook absent
    mkdirSync(deadDir, { recursive: true });
    cvx(["link", "work", deadDir]);
    expect(cvx(["which", deadDir]).out.trim()).toBe("work");
    rmSync(deadDir, { recursive: true, force: true }); // now the link is dead

    const r = cvx(["doctor", "--fix", "--no-tokens"], { env: { SHELL: "/bin/zsh" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("fixed");
    expect(readFileSync(LINKS, "utf8")).not.toContain("gone-proj"); // pruned
    expect(existsSync(zshrc)).toBe(true);
    expect(readFileSync(zshrc, "utf8")).toContain("convex-switch"); // marker installed

    // second run: hook already there, normal diagnosis shows it installed
    const r2 = cvx(["doctor", "--fix", "--no-tokens"], { env: { SHELL: "/bin/zsh" } });
    expect(r2.out).toMatch(/shell hook\s+installed/);
  });

  test("clears a stale active marker naming a ghost account", () => {
    seedAccounts();
    writeFileSync(ACTIVE, "ghost\n");
    const r = cvx(["doctor", "--fix", "--no-tokens"], { env: { SHELL: "/bin/zsh" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("cleared stale active marker");
    expect(readFileSync(ACTIVE, "utf8").split("\n")[0]).toBe("");
  });
});
