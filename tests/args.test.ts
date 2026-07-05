import { describe, expect, test } from "bun:test";
import { parseFlags } from "../src/args";

describe("parseFlags", () => {
  test("positionals collect in _", () => {
    expect(parseFlags(["a", "b"])._).toEqual(["a", "b"]);
  });

  test("boolean long flags never swallow the next positional", () => {
    const f = parseFlags(["--force", "myacct"]);
    expect(f.force).toBe(true);
    expect(f._).toEqual(["myacct"]);
  });

  test("bundled short flags", () => {
    const f = parseFlags(["-qf"]);
    expect(f.q).toBe(true);
    expect(f.f).toBe(true);
  });

  test("value flags consume the next argument", () => {
    const f = parseFlags(["--token", "abc", "name"]);
    expect(f.token).toBe("abc");
    expect(f._).toEqual(["name"]);
  });

  test("value flag does NOT consume a flag-looking argument", () => {
    const f = parseFlags(["--token", "--force"]);
    expect(f.token).toBe(true);
    expect(f.force).toBe(true);
  });

  test("value flag at end of args becomes true (missing value)", () => {
    expect(parseFlags(["--token"]).token).toBe(true);
  });

  test("--key=value works, including leading-dash values", () => {
    expect(parseFlags(["--token=-abc"]).token).toBe("-abc");
    expect(parseFlags(["--shell=zsh"]).shell).toBe("zsh");
  });

  test("--shell consumes a value", () => {
    const f = parseFlags(["--install", "--shell", "nu"]);
    expect(f.install).toBe(true);
    expect(f.shell).toBe("nu");
  });
});
