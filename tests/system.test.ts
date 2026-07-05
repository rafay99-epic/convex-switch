/**
 * Unit tests for src/system.ts — the pure cmd.exe quoting helper and the
 * stdio-inheriting spawn wrapper used by `cvx run`. quoteForCmd is exercised as
 * a pure function on every platform; runInherit is exercised on the host
 * platform (POSIX here). The Windows `.cmd`/`.bat` shim path is validated by the
 * CI matrix (the orchestrator's spaced-argument e2e test).
 */
import { describe, expect, test } from "bun:test";
import { quoteForCmd, runInherit } from "../src/system";

describe("quoteForCmd", () => {
  test("passes a plain token through untouched", () => {
    expect(quoteForCmd("hello")).toBe("hello");
    expect(quoteForCmd("--force")).toBe("--force");
    expect(quoteForCmd("C:\\path\\to\\thing")).toBe("C:\\path\\to\\thing");
  });

  test("quotes an argument containing whitespace", () => {
    expect(quoteForCmd("a b")).toBe('^"a b^"');
  });

  test("escapes and doubles embedded double quotes", () => {
    // a"b → escapeArgument gives "a\"b", then cmd metachar pass carets each quote
    expect(quoteForCmd('a"b')).toBe('^"a\\^"b^"');
  });

  test("doubles a trailing backslash run before the closing quote", () => {
    // A lone backslash isn't a metachar, so it passes through untouched…
    expect(quoteForCmd("a\\")).toBe("a\\");
    // …but once the arg is quoted (here for the space), the trailing backslash
    // is doubled so it can't escape the closing quote.
    expect(quoteForCmd("a b\\")).toBe('^"a b\\\\^"');
  });

  test("caret-escapes cmd shell metacharacters", () => {
    expect(quoteForCmd("a&b")).toBe('^"a^&b^"');
    expect(quoteForCmd("a|b")).toBe('^"a^|b^"');
    expect(quoteForCmd("a<b>c")).toBe('^"a^<b^>c^"');
    expect(quoteForCmd("100%")).toBe('^"100^%^"');
    expect(quoteForCmd("a^b")).toBe('^"a^^b^"');
    // ! is treated as unsafe (delayed expansion) and forces quoting
    expect(quoteForCmd("a!b")).toBe('^"a^!b^"');
  });

  test("quotes the empty string (cmd would otherwise drop it)", () => {
    expect(quoteForCmd("")).toBe('^"^"');
  });
});

describe("runInherit (host platform)", () => {
  test("propagates the child's exit status", () => {
    const r = runInherit(process.execPath, ["-e", "process.exit(5)"], process.env);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(5);
  });

  test("reports ENOENT for a command that does not exist", () => {
    const r = runInherit("cvx-nonexistent-binary-zzz", [], process.env);
    expect(r.error).toBeDefined();
    expect((r.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});
