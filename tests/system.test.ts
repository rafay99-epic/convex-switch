/**
 * Unit tests for src/system.ts — the stdio-inheriting spawn wrapper used by
 * `cvx run`, exercised on the host platform (POSIX here). The Windows
 * `.cmd`/`.bat` shim path is validated by the CI matrix: the spaced-argument
 * and npx-resolution e2e tests in cli.test.ts run on windows-latest.
 */
import { describe, expect, test } from "bun:test";
import { runInherit } from "../src/system";

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
