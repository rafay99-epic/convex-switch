#!/usr/bin/env bash
# cvx sandbox — try a fresh build without touching your real setup.
#
#   scripts/sandbox.sh                start with an empty vault
#   scripts/sandbox.sh --copy-vault   start with a COPY of your real vault
#
# Everything cvx touches (the vault, the global Convex config it swaps, the
# rc files `hook --install` edits) is redirected into a throwaway dir via
# CVX_HOME. Your real ~/.convex-switch, ~/.convex/config.json, and shell rc
# files are never read or written. Type `exit` to leave the sandbox shell.
#
# One rule inside the sandbox: don't run `cvx keychain enable` — the OS
# keychain is per-user, not per-directory, so it can't be sandboxed.
set -euo pipefail
cd "$(dirname "$0")/.."

SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/cvx-sandbox.XXXXXX")
mkdir -p "$SANDBOX/bin"

echo "→ building cvx…"
bun build ./bin/cvx.ts --compile --outfile "$SANDBOX/bin/cvx" >/dev/null

if [ "${1:-}" = "--copy-vault" ]; then
  [ -d "$HOME/.convex-switch" ] && cp -R "$HOME/.convex-switch" "$SANDBOX/.convex-switch"
  if [ -f "$HOME/.convex/config.json" ]; then
    mkdir -p "$SANDBOX/.convex"
    cp "$HOME/.convex/config.json" "$SANDBOX/.convex/config.json"
  fi
  echo "→ copied your vault + Convex login into the sandbox (originals untouched)"
fi

cat <<EOF

✓ Sandbox ready: $SANDBOX
  Inside this shell, \`cvx\` is the fresh build and ALL its state lives in
  the sandbox — experiment freely, your real vault is untouched.
  Leave with \`exit\`; clean up with:  rm -rf $SANDBOX

EOF

CVX_HOME="$SANDBOX" PATH="$SANDBOX/bin:$PATH" "${SHELL:-bash}"
