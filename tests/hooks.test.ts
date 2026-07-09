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
