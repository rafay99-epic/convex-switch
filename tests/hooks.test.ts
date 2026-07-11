/**
 * Unit tests for src/hooks.ts's replaceHookBlock — the block-swap logic
 * shared by `cvx hook --install` and `doctor --fix`. Pure string manipulation,
 * no CVX_HOME I/O, but this file still relies on the sandbox CVX_HOME the
 * preload (tests/preload.ts) bound before any test file loaded, per this
 * repo's unit-test convention — never mint a private mkdtemp here.
 */
import { describe, expect, test } from "bun:test";

const hooks = await import("../src/hooks");

const SNIPPET = hooks.hookFor("zsh");

describe("replaceHookBlock", () => {
  test("complete-block replacement preserves surrounding lines", () => {
    const before = "# my own stuff, before the block\nalias gs='git status'\n";
    const after = "# my own stuff, after the block\nexport EDITOR=vim\n";
    const oldBlock =
      "# --- convex-switch ---------------------------------------------------------\n" +
      "_convex_switch_hook() { command cvx activate -q 2>/dev/null }\n" +
      "# --- end convex-switch -----------------------------------------------------\n";
    const body = before + oldBlock + after;

    const result = hooks.replaceHookBlock(body, SNIPPET);

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.body.startsWith(before)).toBe(true);
    expect(result!.body.endsWith(after)).toBe(true);
    expect(result!.body).toContain("_convex_switch_precmd");
    expect(result!.body).not.toContain("_convex_switch_hook() { command cvx activate -q 2>/dev/null }");
  });

  test("identical block returns changed:false and an identical body", () => {
    const body = "before\n" + SNIPPET + "after\n";

    const result = hooks.replaceHookBlock(body, SNIPPET);

    expect(result).toEqual({ body, changed: false });
  });

  test("a CRLF body with a current block reads as unchanged", () => {
    // A Windows $PROFILE (or an rc touched by a Windows editor) stores CRLF —
    // the block must still compare equal to the LF snippet, or doctor would
    // report it outdated forever and every install would rewrite the file.
    const body = ("before\n" + SNIPPET + "after\n").replaceAll("\n", "\r\n");

    const result = hooks.replaceHookBlock(body, SNIPPET);

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(false);
  });

  test("swapping an outdated block in a CRLF body keeps CRLF endings throughout", () => {
    const oldBlock =
      "# --- convex-switch ---------------------------------------------------------\n" +
      "_convex_switch_hook() { command cvx activate -q 2>/dev/null }\n" +
      "# --- end convex-switch -----------------------------------------------------\n";
    const body = ("before\n" + oldBlock + "after\n").replaceAll("\n", "\r\n");

    const result = hooks.replaceHookBlock(body, SNIPPET);

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.body).toContain("_convex_switch_precmd");
    // No mixed endings: stripping every CRLF must leave no bare LF behind.
    expect(result!.body.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("body without markers returns null", () => {
    const body = "just some rc content\nalias ll='ls -la'\n";

    expect(hooks.replaceHookBlock(body, SNIPPET)).toBeNull();
  });

  test("start marker without end marker returns null", () => {
    const body =
      "before\n" +
      "# --- convex-switch ---------------------------------------------------------\n" +
      "some stray hand-edited line\n";

    expect(hooks.replaceHookBlock(body, SNIPPET)).toBeNull();
  });
});

describe("envLine", () => {
  const acct = { name: "work", token: "tok-AAA" };

  test("posix export and unset", () => {
    expect(hooks.envLine("zsh", acct)).toBe(
      "export CVX_ACCOUNT='work' CONVEX_OVERRIDE_ACCESS_TOKEN='tok-AAA'",
    );
    expect(hooks.envLine("bash")).toBe("unset CVX_ACCOUNT CONVEX_OVERRIDE_ACCESS_TOKEN");
  });

  test("posix quoting survives single quotes in the value", () => {
    const line = hooks.envLine("zsh", { name: "a", token: "it's" });
    expect(line).toContain("CONVEX_OVERRIDE_ACCESS_TOKEN='it'\\''s'");
  });

  test("fish set/erase", () => {
    expect(hooks.envLine("fish", acct)).toBe(
      "set -gx CVX_ACCOUNT 'work'; set -gx CONVEX_OVERRIDE_ACCESS_TOKEN 'tok-AAA'",
    );
    expect(hooks.envLine("fish")).toBe("set -e CVX_ACCOUNT; set -e CONVEX_OVERRIDE_ACCESS_TOKEN");
  });

  test("powershell set/remove, quotes doubled", () => {
    expect(hooks.envLine("powershell", { name: "a", token: "it's" })).toBe(
      "$env:CVX_ACCOUNT = 'a'; $env:CONVEX_OVERRIDE_ACCESS_TOKEN = 'it''s'",
    );
    expect(hooks.envLine("powershell")).toBe(
      "Remove-Item Env:CVX_ACCOUNT,Env:CONVEX_OVERRIDE_ACCESS_TOKEN -ErrorAction SilentlyContinue",
    );
  });

  test("always a single line (it gets eval'd by the hooks)", () => {
    for (const shell of hooks.SHELLS)
      for (const a of [acct, undefined]) expect(hooks.envLine(shell, a)).not.toContain("\n");
  });
});
