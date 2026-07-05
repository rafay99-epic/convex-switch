# CLAUDE.md

Guidance for AI assistants (and humans) working in this repo.

## What this is

`cvx` (convex-switch) — a Bun-compiled CLI that binds Convex accounts to
project directories and swaps the single global `~/.convex/config.json` as you
`cd` between projects. Entry point `bin/cvx.ts`, logic in `src/` (see the
"Project layout" section of the README). No runtime dependencies; the release
is a standalone binary.

## Commands

```sh
bun test                                          # full test suite (unit + e2e) — must pass before any PR
bun build ./bin/cvx.ts --compile --outfile dist/cvx   # release-style build
scripts/sandbox.sh [--copy-vault]                 # interactive sandbox shell for manual testing
```

There is no tsconfig and no `node_modules`; Bun resolves everything.

## Attribution policy — STRICT

**No AI attribution anywhere in this repo.** Do not add
`Co-Authored-By: Claude …` (or any AI co-author trailer) to commits, and do
not add "Generated with Claude Code" or similar banners to commit messages,
PR titles/bodies, issues, code comments, or docs. Commits and PRs are
authored by the repo owner, full stop.

## Safety rules — never break these

- **Never run `cvx` against the real HOME** during development or tests.
  Always set `CVX_HOME=<throwaway dir>` (it relocates the vault, the global
  Convex config, and the rc files `hook --install` edits). The test suite and
  `scripts/sandbox.sh` already do this.
- **Never run `cvx keychain enable|disable` in tests or sandboxes.** The OS
  keychain is per-user, not per-HOME — it would write to the developer's real
  keychain.
- **Never invoke `cvx open` bare in tests** — it launches a browser. Put a
  stub `open` (macOS) / `xdg-open` (Linux) first on PATH; the e2e tests show
  the pattern.
- **Never run real `cvx login` / `cvx refresh <existing>` in tests** — they
  open a browser via `npx convex login`. Only their argument-error paths are
  testable.
- **Do not push to `main`.** Pushing to `main` (touching `bin/**` or
  `package.json`) triggers the release workflow and publishes a real release
  (GitHub + Homebrew + npm). All changes go through PRs.

## Testing conventions

- Tests live in `tests/` and run with `bun test`. E2E tests spawn
  `bun bin/cvx.ts …` with a fresh `mkdtemp` `CVX_HOME` per suite and assert on
  exit codes and output. `NO_COLOR=1` keeps output assertable.
- **Unit-test files must use `process.env.CVX_HOME` (set by `tests/preload.ts`
  via bunfig.toml before any file loads) — never mint their own mkdtemp.**
  Test files load in no guaranteed order and share one module cache; a private
  mkdtemp can diverge from where src/paths.ts actually bound, and an import
  without CVX_HOME set would bind the REAL home directory.
- `CVX_PASSPHRASE` makes `cvx vault …` and `cvx export`/`import`
  non-interactive — tests use it so nothing ever prompts.
- The interactive migration prompt needs a real PTY, which `bun test` doesn't
  provide — that one flow is covered by the manual recipe in
  `scripts/sandbox.sh` (make the vault legacy, run any interactive command).
- Anything touching `verifyToken` hits the network; tests only assert on its
  error paths and must tolerate both online (401) and offline messages.

## Output hygiene (colors / mascot / spinners)

- Piped output must stay byte-identical to plain text: colors gate on
  `stdout.isTTY && !NO_COLOR` (colors.ts), the mascot prints only when
  `process.stdout.isTTY`, and the spinner (spinner.ts) prints nothing until
  `stop(finalLine)` when not on a TTY. Never `process.stdout.write` animation
  frames outside spinner.ts.
- Action result lines get Vex's reaction via `vexTag(mood, account?)` from
  ui.ts — it returns "" when piped, so it is the ONLY sanctioned way to put
  her on a command's output. Never concatenate `vex(...)` into output without
  a TTY gate.
- `which`, `prompt`, `accounts --names`, and `status --json` are scripting
  surfaces — no decoration, ever.
- Pad-then-colorize (`accountColor(name, name.padEnd(14))`) — colorizing before
  padEnd breaks column alignment because ANSI codes count as characters.
- No spinners or new work on the cd-hook hot path (`activate`, `prompt`).

## Architecture notes worth knowing

- `src/paths.ts` is the ONLY place `HOME` is resolved (that's what makes
  `CVX_HOME` a complete sandbox). Keep it that way. vault.ts must not import
  store.ts (store imports it) — that's why paths live in their own module.
- Vault files are written atomically (temp + rename) and chmod 600; the vault
  dir is 700. `readVaultJSON` treats a corrupt file as fatal on purpose —
  never "fix" it to silently reset, that loses accounts.
- The active marker (`.convex-switch/active`) is two lines: account name,
  then a SHA-256 token fingerprint. The cd-hook fast path trusts it only when
  the fingerprint matches the current global token.
- `cvx activate` runs on every `cd` via shell hooks — treat it as a hot path
  (no network, no extra process spawns, must never throw).
- The default file vault stores tokens in PLAINTEXT (mode 600). Never describe
  it as encrypted; the opt-in encrypted options are the OS keychain
  (`cvx keychain enable`) and the passphrase vault (`cvx vault encrypt`, see
  src/vault.ts — ssh-agent-style session key cached under the OS temp dir,
  keyed by vault path so sandboxes never share a session with the real vault).
