/**
 * crypto — passphrase-based encryption shared by the encrypted vault and
 * `cvx export`/`import`. scrypt key derivation + AES-256-GCM, nothing exotic.
 * Blob layout (base64): 12-byte IV | 16-byte GCM tag | ciphertext.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// Interactive-unlock cost: ~100ms on current laptops, GPU-hostile enough for
// a file that never leaves the machine unencrypted.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export const newSalt = () => randomBytes(16);

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT);
}

export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

/** null on a wrong key or a tampered blob (GCM authenticates). */
export function decrypt(key: Buffer, blob: string): string | null {
  try {
    const b = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
