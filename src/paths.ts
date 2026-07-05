/**
 * paths — the ONE place HOME is resolved. Everything cvx touches lives under
 * this base dir: the vault, the global Convex config it swaps, and the rc
 * files `hook --install` edits. Setting CVX_HOME relocates ALL of it — a fully
 * isolated sandbox for testing (`CVX_HOME=/tmp/cvx-sandbox cvx …`).
 * NOTE: the OS keychain is per-user, not per-HOME — stick to the default file
 * backend in a sandbox (don't run `cvx keychain enable` there).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.CVX_HOME || homedir();
export const VAULT = join(HOME, ".convex-switch");
