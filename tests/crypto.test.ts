import { describe, expect, test } from "bun:test";
import { decrypt, deriveKey, encrypt, newSalt } from "../src/crypto";

describe("crypto", () => {
  const salt = newSalt();
  const key = deriveKey("passphrase-123", salt);

  test("encrypt/decrypt round-trip", () => {
    expect(decrypt(key, encrypt(key, "hello tokens"))).toBe("hello tokens");
  });

  test("wrong key → null", () => {
    const other = deriveKey("different-pass", salt);
    expect(decrypt(other, encrypt(key, "hello"))).toBe(null);
  });

  test("tampered ciphertext → null (GCM authenticates)", () => {
    const blob = Buffer.from(encrypt(key, "hello"), "base64");
    blob[blob.length - 1] ^= 1;
    expect(decrypt(key, blob.toString("base64"))).toBe(null);
  });

  test("garbage input → null, never a throw", () => {
    expect(decrypt(key, "not-base64!!")).toBe(null);
    expect(decrypt(key, "")).toBe(null);
  });

  test("deriveKey is deterministic per salt, distinct across salts", () => {
    expect(deriveKey("p1-longer", salt).equals(deriveKey("p1-longer", salt))).toBe(true);
    expect(deriveKey("p1-longer", newSalt()).equals(deriveKey("p1-longer", salt))).toBe(false);
  });
});
