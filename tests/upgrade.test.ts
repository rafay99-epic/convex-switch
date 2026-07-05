import { describe, expect, test } from "bun:test";
import { compareVersions, detectChannel } from "../src/upgrade";

describe("compareVersions", () => {
  test("orders lower before higher", () => {
    expect(compareVersions("0.42", "0.43.0")).toBeLessThan(0);
  });

  test("orders higher above lower", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
  });

  test("equal versions compare as 0", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("different lengths: trailing zero segment is equal", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  test("different lengths: extra nonzero segment is greater", () => {
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  test("junk (non-numeric) segments compare as 0", () => {
    expect(compareVersions("1.dev.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.0.0-dev", "0.0.0")).toBe(0);
  });
});

describe("detectChannel", () => {
  test("macOS Homebrew Cellar path", () => {
    expect(detectChannel("/usr/local/Cellar/cvx/0.42/bin/cvx")).toBe("homebrew");
  });

  test("linuxbrew path", () => {
    expect(detectChannel("/home/linuxbrew/.linuxbrew/bin/cvx")).toBe("homebrew");
  });

  test("generic /homebrew/ path", () => {
    expect(detectChannel("/opt/homebrew/bin/cvx")).toBe("homebrew");
  });

  test("~/.bun install path", () => {
    expect(detectChannel("/Users/dev/.bun/bin/cvx")).toBe("npm");
  });

  test("node_modules path", () => {
    expect(detectChannel("/Users/dev/project/node_modules/.bin/cvx")).toBe("npm");
  });

  test("bare /usr/local/bin path falls back to github", () => {
    expect(detectChannel("/usr/local/bin/cvx")).toBe("github");
  });
});
