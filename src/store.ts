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
export const ACCOUNTS_FILE = join(VAULT, "accounts.json");
export const LINKS_FILE = join(VAULT, "links.json");
export const CONFIG_FILE = join(VAULT, "config.json");
export const ACTIVE_FILE = join(VAULT, "active");
export const WELCOME_MARKER = join(VAULT, ".welcomed");
export const CONVEX_CONFIG = join(HOME, ".convex", "config.json");
export const API_TEAMS = "https://api.convex.dev/api/teams";
export const CLIENT = `convex-switch/${VERSION}`;

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
export type Config = { storage?: Backend };

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

// --- Active-account marker --------------------------------------------------
// A fast, name-only record of which account the global config currently holds,
// so the cd-hook can no-op without reading (and, with keychain, without a slow
// secret lookup) when the linked account is already active.

export function readActive(): string | null {
  try {
    const v = readFileSync(ACTIVE_FILE, "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}
export function writeActive(name: string) {
  try {
    writeFileSync(ACTIVE_FILE, name + "\n", { mode: 0o600 });
  } catch {}
}
export function clearActive() {
  try {
    if (existsSync(ACTIVE_FILE)) writeFileSync(ACTIVE_FILE, "", { mode: 0o600 });
  } catch {}
}

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
            return v.replace(/^(dev|prod|local|preview):/, "") || null;
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
