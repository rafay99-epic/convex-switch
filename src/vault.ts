/**
 * vault — optional passphrase encryption for the file vault. Tokens become
 * `pw` records (AES-256-GCM blobs) in accounts.json; the key is derived from a
 * passphrase (scrypt) and cached OUTSIDE the vault dir for the session, so a
 * backup or rsync of ~/.convex-switch alone is useless without the passphrase.
 *
 * Session model (ssh-agent-like): `cvx vault unlock` derives + verifies the
 * key and caches it in a per-vault 0600 file under the OS temp dir (cleared on
 * reboot / `cvx vault lock`). The hot cd-hook path then decrypts in-process —
 * no prompt, no spawn. While locked, token reads return null and commands
 * point at `cvx vault unlock`.
 *
 * This module must not import store.ts (store imports us) — paths come from
 * paths.ts, and our own metadata lives in vault.json inside the vault dir.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decrypt, deriveKey, encrypt, newSalt } from "./crypto";
import { VAULT } from "./paths";

const META = join(VAULT, "vault.json"); // { salt, canary } — present ⇔ passphrase vault set up
const CANARY = "cvx-vault-canary-v1";

// Keyed by vault path so sandboxes (CVX_HOME) never share a session with the
// real vault, and parallel test homes never collide.
const sessionFile = () =>
  join(tmpdir(), "cvx-session-" + createHash("sha256").update(VAULT).digest("hex").slice(0, 12));

export const vaultInitialized = (): boolean => existsSync(META);
export const vaultLocked = (): boolean => vaultInitialized() && sessionKey() == null;

function sessionKey(): Buffer | null {
  try {
    const k = Buffer.from(readFileSync(sessionFile(), "utf8").trim(), "base64");
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

function cacheSession(key: Buffer) {
  // Atomic (temp + rename): the cd-hook reads this file concurrently, and a
  // torn read would make sessionKey() return null — the vault would look
  // locked mid-`vault unlock`. (Can't reuse store.ts's writer: store imports us.)
  const file = sessionFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, key.toString("base64") + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

/** First-time setup: persist salt + canary, cache the session key. */
export function initVault(passphrase: string) {
  const salt = newSalt();
  const key = deriveKey(passphrase, salt);
  writeFileSync(
    META,
    JSON.stringify({ salt: salt.toString("base64"), canary: encrypt(key, CANARY) }, null, 2) + "\n",
    { mode: 0o600 },
  );
  cacheSession(key);
}

/** Verify a passphrase and cache its key for the session. False = wrong passphrase. */
export function unlock(passphrase: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(META, "utf8")) as { salt: string; canary: string };
    const key = deriveKey(passphrase, Buffer.from(meta.salt, "base64"));
    if (decrypt(key, meta.canary) !== CANARY) return false;
    cacheSession(key);
    return true;
  } catch {
    return false;
  }
}

export function lock() {
  try {
    unlinkSync(sessionFile());
  } catch {}
}

/** Remove the vault metadata (after tokens moved back to plain records). */
export function destroyVaultMeta() {
  lock();
  try {
    unlinkSync(META);
  } catch {}
}

/** Encrypt a token for a `pw` record. Throws while locked — callers surface it. */
export function encryptToken(token: string): string {
  const key = sessionKey();
  if (!key) throw new Error("the vault is locked — run `cvx vault unlock` first.");
  return encrypt(key, token);
}

/** null while locked or on a tampered blob. */
export function decryptToken(pw: string): string | null {
  const key = sessionKey();
  return key ? decrypt(key, pw) : null;
}
