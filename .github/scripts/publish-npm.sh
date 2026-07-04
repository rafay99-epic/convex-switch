#!/usr/bin/env bash
#
# Publish @rafay99/cvx to npm as a distribution channel for the prebuilt
# binaries (the same ones Homebrew ships). Uses the esbuild/biome model:
#
#   @rafay99/cvx                     main package: a launcher + optionalDeps
#   @rafay99/cvx-darwin-arm64  ┐
#   @rafay99/cvx-darwin-x64    │  per-platform packages, each carrying one
#   @rafay99/cvx-linux-x64     │  compiled `cvx` binary, gated by os/cpu
#   @rafay99/cvx-linux-arm64   ┘
#
# npm/bun/pnpm install only the platform package matching the user's machine,
# and the launcher execs its binary — no postinstall, so `bun add -g` works too.
#
# Usage:  VERSION=0.42 NPM_TOKEN=… bash publish-npm.sh [dist-dir]
# Requires: node, npm, tar. dist-dir (default ./dist) holds the cvx-*.tar.gz.

set -euo pipefail

VERSION="${VERSION:?VERSION env var required}"   # e.g. 0.42  (Homebrew-style)
: "${NPM_TOKEN:?NPM_TOKEN env var required}"
DIST="${1:-dist}"
NPM_VERSION="${VERSION}.0"                        # 0.42 -> 0.42.0 (valid semver)
NAME="@rafay99/cvx"                               # scoped: command stays `cvx`
REPO="https://github.com/rafay99-epic/convex-switch"

# Platform matrix: <os> <arch> <tarball-suffix>  (os/arch = node's platform/arch)
PLATFORMS=(
  "darwin arm64"
  "darwin x64"
  "linux x64"
  "linux arm64"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export NPM_CONFIG_USERCONFIG="$WORK/.npmrc"
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPM_CONFIG_USERCONFIG"

publish_if_new() { # <dir> <pkg-name>
  local dir="$1" pkg="$2"
  if npm view "${pkg}@${NPM_VERSION}" version >/dev/null 2>&1; then
    echo "::notice::${pkg}@${NPM_VERSION} already published — skipping."
    return 0
  fi
  ( cd "$dir" && npm publish --access public )
}

# --- per-platform packages (publish these first, main depends on them) ------
for entry in "${PLATFORMS[@]}"; do
  read -r os arch <<<"$entry"
  pkg="${NAME}-${os}-${arch}"          # e.g. @rafay99/cvx-darwin-arm64
  dir="$WORK/plat-${os}-${arch}"       # flat dir (pkg name has a '/')
  mkdir -p "$dir/bin"
  tar -xzf "$DIST/cvx-${os}-${arch}.tar.gz" -C "$dir/bin" cvx
  chmod +x "$dir/bin/cvx"
  cat > "$dir/package.json" <<JSON
{
  "name": "${pkg}",
  "version": "${NPM_VERSION}",
  "description": "cvx prebuilt binary for ${os}-${arch}",
  "license": "MIT",
  "repository": "${REPO}",
  "os": ["${os}"],
  "cpu": ["${arch}"],
  "files": ["bin/cvx"]
}
JSON
  echo "→ publishing ${pkg}@${NPM_VERSION}"
  publish_if_new "$dir" "$pkg"
done

# --- main package: launcher + optionalDependencies --------------------------
main="$WORK/main"
mkdir -p "$main"
cp npm/launcher.js "$main/launcher.js"
cp man/cvx.1 "$main/cvx.1"
cat > "$main/package.json" <<JSON
{
  "name": "${NAME}",
  "version": "${NPM_VERSION}",
  "description": "Switch Convex accounts per project automatically — no deploy keys, no tokens in repos",
  "keywords": ["convex", "cli", "accounts", "multi-account", "workspace"],
  "license": "MIT",
  "homepage": "${REPO}",
  "repository": "${REPO}",
  "bin": { "cvx": "launcher.js" },
  "man": ["cvx.1"],
  "files": ["launcher.js", "cvx.1"],
  "engines": { "node": ">=16" },
  "optionalDependencies": {
    "${NAME}-darwin-arm64": "${NPM_VERSION}",
    "${NAME}-darwin-x64": "${NPM_VERSION}",
    "${NAME}-linux-x64": "${NPM_VERSION}",
    "${NAME}-linux-arm64": "${NPM_VERSION}"
  }
}
JSON
echo "→ publishing ${NAME}@${NPM_VERSION}"
publish_if_new "$main" "$NAME"

echo "::notice::Published ${NAME} ${NPM_VERSION} to npm (main + 4 platform packages)."
