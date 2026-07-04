/**
 * store — the data layer. Vault I/O, the Convex global-config swap, token
 * verification, path resolution, and first-run state. No presentation here
 * (colors/printing live in ui.ts).
 */

import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  realpathSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import {
  type Backend,
  detectBackend,
  storeToken,
  loadToken,
  deleteToken,
} from "./keychain";

// Placeholder for local/dev runs; the release workflow stamps the real
// 0.<commit-count> version into this line before compiling (see release.yml).
export const VERSION = "0.0.0-dev";

// --- Paths & constants ------------------------------------------------------

export const HOME = homedir();
export const VAULT = join(HOME, ".convex-switch");
const ACCOUNTS_FILE = join(VAULT, "accounts.json");
const LINKS_FILE = join(VAULT, "links.json");
const CONFIG_FILE = join(VAULT, "config.json");
const ACTIVE_FILE = join(VAULT, "active");
const WELCOME_MARKER = join(VAULT, ".welcomed");
const CONVEX_CONFIG = join(HOME, ".convex", "config.json");
const API_TEAMS = "https://api.convex.dev/api/teams";
const CLIENT = `convex-switch/${VERSION}`;

// Vault schema version. Bump when the on-disk format changes; a legacy vault
// (no schemaVersion, or a lower one) triggers the one-time migration prompt.
export const SCHEMA = 2;

// --- Types ------------------------------------------------------------------

export type Team = { slug: string; name: string };
/**
 * An account's token lives in exactly one place: inline (`token`, the default
 * file vault), the OS keychain (`keychain: true`), or a DPAPI blob (`enc`, on
 * Windows). Resolve with tokenOf(); never read `.token` directly.
 */
export type Account = {
  token?: string;
  keychain?: boolean;
  enc?: string;
  teams: Team[];
  addedAt: string;
};
export type Accounts = Record<string, Account>;
export type Links = Record<string, string>; // absolute project path -> account name
export type Config = { storage?: Backend; schemaVersion?: number };

// --- Vault I/O (dir 700, files 600) -----------------------------------------

export function ensureVault() {
  // A brand-new vault (no accounts file yet) is born at the current schema, so
  // fresh installs never see the migration prompt. A vault that already has an
  // accounts file but no schemaVersion is a LEGACY vault — left untouched here
  // so maybeMigrate() can prompt the user before upgrading it.
  const fresh = !existsSync(ACCOUNTS_FILE);
  if (!existsSync(VAULT)) mkdirSync(VAULT, { recursive: true, mode: 0o700 });
  try {
    chmodSync(VAULT, 0o700);
  } catch {}
  if (!existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, {});
  if (!existsSync(LINKS_FILE)) writeJSON(LINKS_FILE, {});
  if (fresh && !existsSync(CONFIG_FILE)) writeJSON(CONFIG_FILE, { schemaVersion: SCHEMA });
}

/** Lenient read (used for Convex's own config): any problem → fallback. */
function readJSON<T>(file: string, fallback: T): T {
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
function readVaultJSON<T>(file: string, fallback: T): T {
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

/**
 * Atomic write (temp file + rename): a crash mid-write can never leave a
 * truncated file behind — that matters because readVaultJSON treats a torn
 * vault file as fatal, and a torn ~/.convex/config.json would log the user out.
 */
function writeFileAtomic(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function writeJSON(file: string, data: unknown) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

export const readAccounts = () => readVaultJSON<Accounts>(ACCOUNTS_FILE, {});
export const writeAccounts = (a: Accounts) => writeJSON(ACCOUNTS_FILE, a);
export const readLinks = () => readVaultJSON<Links>(LINKS_FILE, {});
export const writeLinks = (l: Links) => writeJSON(LINKS_FILE, l);
export const readConfig = () => readVaultJSON<Config>(CONFIG_FILE, {});
export const writeConfig = (c: Config) => writeJSON(CONFIG_FILE, c);

// --- Token storage backend (file / OS keychain) -----------------------------

/** The configured storage backend, defaulting to plain file. */
export function storageBackend(): Backend {
  return readConfig().storage ?? "file";
}

/** Best keychain backend available on this machine (for `keychain enable`). */
export { detectBackend, deleteToken };

/** Resolve an account's actual token from wherever its record keeps it. */
export function tokenOf(name: string, acc: Account): string | null {
  return loadToken(name, acc);
}

/** Build an account record that stores `token` via the given backend. */
export function makeTokenRecord(backend: Backend, name: string, token: string) {
  return storeToken(backend, name, token);
}

/** Rebuild an account around a new token record, preserving its metadata. */
export function withTokenRecord(acc: Account, rec: ReturnType<typeof storeToken>): Account {
  return { teams: acc.teams, addedAt: acc.addedAt, ...rec };
}

/**
 * Account names become JSON keys, OS-keychain entries, and shell-completion
 * output — restrict them to a safe charset. Requiring an alphanumeric first
 * character also blocks `__proto__` (which JSON.parse-derived objects silently
 * refuse to store as an own key, losing the account).
 */
export function validAccountName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

// --- Active-account marker --------------------------------------------------
// A fast record of which account the global config currently holds: line 1 is
// the account name, line 2 a fingerprint of its token. The cd-hook uses it to
// no-op without a slow keychain lookup — the fingerprint lets it detect that
// something else (e.g. `npx convex login`) replaced the global token, so a
// stale marker can never keep the wrong account silently "active".

const tokenFingerprint = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

export function readActive(): string | null {
  try {
    const name = readFileSync(ACTIVE_FILE, "utf8").split("\n")[0].trim();
    return name || null;
  } catch {
    return null;
  }
}

/** True when the marker's fingerprint matches `token` (markers written without one never match). */
export function activeTokenMatches(token: string): boolean {
  try {
    const fp = readFileSync(ACTIVE_FILE, "utf8").split("\n")[1]?.trim();
    return !!fp && fp === tokenFingerprint(token);
  } catch {
    return false;
  }
}

export function writeActive(name: string, token?: string) {
  try {
    const fp = token ? tokenFingerprint(token) + "\n" : "";
    writeFileSync(ACTIVE_FILE, name + "\n" + fp, { mode: 0o600 });
  } catch {}
}
export function clearActive() {
  try {
    if (existsSync(ACTIVE_FILE)) writeFileSync(ACTIVE_FILE, "", { mode: 0o600 });
  } catch {}
}

// --- Convex global config (the single account switch) -----------------------

export function currentConvexToken(): string | null {
  const token = readJSON<{ accessToken?: unknown }>(CONVEX_CONFIG, {}).accessToken;
  return typeof token === "string" && token ? token : null;
}

export function setConvexToken(token: string) {
  const dir = dirname(CONVEX_CONFIG);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Preserve any other fields Convex may keep in the file.
  const existing = readJSON<Record<string, unknown>>(CONVEX_CONFIG, {});
  existing.accessToken = token;
  writeFileAtomic(CONVEX_CONFIG, JSON.stringify(existing, null, 2) + "\n");
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

/**
 * Read CONVEX_DEPLOYMENT from the nearest .env.local (walking up from dir).
 * Returns the deployment name without its `dev:`/`prod:`/`local:` type prefix,
 * or null. Used by `cvx open`.
 */
export function projectDeployment(dir: string): string | null {
  let cur = canon(dir);
  while (true) {
    const envFile = join(cur, ".env.local");
    if (existsSync(envFile)) {
      try {
        for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
          const m = line.match(/^\s*CONVEX_DEPLOYMENT\s*=\s*(.+?)\s*(#.*)?$/);
          if (m) {
            let v = m[1].trim().replace(/^["']|["']$/g, "");
            // strip an inline "# team: ..." comment tail and the type prefix
            v = v.split("#")[0].trim();
            v = v.replace(/^(dev|prod|local|preview):/, "");
            // The value lands in a URL handed to the OS opener (`cmd /c start`
            // on Windows) — only accept real deployment-name characters, so a
            // hostile .env.local can't smuggle shell metacharacters through.
            return /^[A-Za-z0-9._-]+$/.test(v) ? v : null;
          }
        }
      } catch {
        /* unreadable env — ignore */
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Name of the account whose token the global config currently holds. */
export function activeAccountName(accounts: Accounts): string | null {
  const cur = currentConvexToken();
  if (!cur) return null;
  const marked = readActive();
  if (marked && accounts[marked] && tokenOf(marked, accounts[marked]) === cur) return marked;
  for (const [name, acc] of Object.entries(accounts)) if (tokenOf(name, acc) === cur) return name;
  return null;
}

// --- First-run state --------------------------------------------------------

export const isFirstRun = () => !existsSync(WELCOME_MARKER);
export function markWelcomed() {
  try {
    writeFileSync(WELCOME_MARKER, new Date().toISOString() + "\n", { mode: 0o600 });
  } catch {}
}
