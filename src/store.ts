/**
 * store — the data layer. Vault I/O, the Convex global-config swap, token
 * verification, path resolution, and first-run state. No presentation here
 * (colors/printing live in ui.ts).
 */

import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";

export const VERSION = "0.4";

// --- Paths & constants ------------------------------------------------------

export const HOME = homedir();
export const VAULT = join(HOME, ".convex-switch");
export const ACCOUNTS_FILE = join(VAULT, "accounts.json");
export const LINKS_FILE = join(VAULT, "links.json");
export const WELCOME_MARKER = join(VAULT, ".welcomed");
export const CONVEX_CONFIG = join(HOME, ".convex", "config.json");
export const API_TEAMS = "https://api.convex.dev/api/teams";
export const CLIENT = `convex-switch/${VERSION}`;

// --- Types ------------------------------------------------------------------

export type Team = { slug: string; name: string };
export type Account = { token: string; teams: Team[]; addedAt: string };
export type Accounts = Record<string, Account>;
export type Links = Record<string, string>; // absolute project path -> account name

// --- Vault I/O (dir 700, files 600) -----------------------------------------

export function ensureVault() {
  if (!existsSync(VAULT)) mkdirSync(VAULT, { recursive: true, mode: 0o700 });
  try {
    chmodSync(VAULT, 0o700);
  } catch {}
  if (!existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, {});
  if (!existsSync(LINKS_FILE)) writeJSON(LINKS_FILE, {});
}

/** Lenient read (used for Convex's own config): any problem → fallback. */
export function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Strict read for our own vault files: a missing/empty file is fine (fallback),
 * but a present-yet-unparseable file THROWS rather than silently resetting —
 * otherwise the next write would clobber a recoverable file and lose accounts.
 */
export function readVaultJSON<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf8");
  if (raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `${file} is corrupted (invalid JSON). Fix or delete it, then re-run.`,
    );
  }
}

export function writeJSON(file: string, data: unknown) {
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export const readAccounts = () => readVaultJSON<Accounts>(ACCOUNTS_FILE, {});
export const writeAccounts = (a: Accounts) => writeJSON(ACCOUNTS_FILE, a);
export const readLinks = () => readVaultJSON<Links>(LINKS_FILE, {});
export const writeLinks = (l: Links) => writeJSON(LINKS_FILE, l);

// --- Convex global config (the single account switch) -----------------------

export function currentConvexToken(): string | null {
  try {
    return JSON.parse(readFileSync(CONVEX_CONFIG, "utf8")).accessToken ?? null;
  } catch {
    return null;
  }
}

export function setConvexToken(token: string) {
  const dir = dirname(CONVEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Preserve any other fields Convex may keep in the file.
  const existing = readJSON<Record<string, unknown>>(CONVEX_CONFIG, {});
  existing.accessToken = token;
  writeFileSync(CONVEX_CONFIG, JSON.stringify(existing, null, 2) + "\n", {
    mode: 0o600,
  });
}

// --- Verify a token against Convex (also reveals its teams) -----------------

export async function verifyToken(token: string): Promise<Team[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    let res: Response;
    try {
      res = await fetch(API_TEAMS, {
        headers: { Authorization: `Bearer ${token}`, "Convex-Client": CLIENT },
        signal: ctrl.signal,
      });
    } catch (e) {
      // Network-level failure (offline, DNS, timeout) — not an auth problem.
      if ((e as Error).name === "AbortError")
        throw new Error("timed out reaching Convex (check your connection)");
      throw new Error("couldn't reach Convex — are you online?");
    }
    if (res.status === 401 || res.status === 403)
      throw new Error("token rejected by Convex (expired or invalid)");
    if (!res.ok) throw new Error(`Convex API returned ${res.status}`);
    let teams: Team[];
    try {
      teams = (await res.json()) as Team[];
    } catch {
      throw new Error("Convex returned an unexpected (non-JSON) response");
    }
    if (!Array.isArray(teams)) throw new Error("Convex returned an unexpected response shape");
    return teams.map((t) => ({ slug: t.slug, name: t.name }));
  } finally {
    clearTimeout(t);
  }
}

// --- Path resolution --------------------------------------------------------

/** Canonical absolute path (resolves symlinks like /tmp -> /private/tmp). */
export function canon(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs; // path may not exist yet; fall back to normalized absolute
  }
}

export function shortPath(p: string): string {
  return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p;
}

/** Which account a directory belongs to (walk up to the nearest link). */
export function resolveLink(dir: string): { path: string; account: string } | null {
  const links = readLinks();
  let cur = canon(dir);
  while (true) {
    if (links[cur]) return { path: cur, account: links[cur] };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// --- First-run state --------------------------------------------------------

export const isFirstRun = () => !existsSync(WELCOME_MARKER);
export function markWelcomed() {
  try {
    writeFileSync(WELCOME_MARKER, new Date().toISOString() + "\n", { mode: 0o600 });
  } catch {}
}
