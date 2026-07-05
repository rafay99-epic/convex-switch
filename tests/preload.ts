/**
 * Test preload (wired via bunfig.toml) — runs before ANY test file loads.
 *
 * src/paths.ts resolves HOME once, at first import, from CVX_HOME. Test files
 * load in no guaranteed order, and some import src modules without thinking
 * about HOME (e.g. upgrade.test.ts → store.ts) — if one of those loads first,
 * the whole process would bind to the REAL home directory and unit tests
 * would read/write the developer's actual vault. Setting a throwaway CVX_HOME
 * here, before anything else loads, makes that impossible. Unit-test files
 * must use process.env.CVX_HOME (this sandbox) rather than minting their own.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CVX_HOME = mkdtempSync(join(tmpdir(), "cvx-unit."));
