#!/bin/bash
# Copyright 2026 Workloom Solutions Private Limited
# SPDX-License-Identifier: MIT
# Release generation fills the version and app checksum before this script ships.
set -euo pipefail
umask 077
APP_VERSION='__CODEBASE_TRAIL_VERSION__'
APP_SHA256='__CODEBASE_TRAIL_APP_SHA256__'
APP_REPOSITORY='__CODEBASE_TRAIL_REPOSITORY__'
NODE_VERSION='24.22.1'
NO_LAUNCH=0
APP_ARCHIVE=''
fail() { printf 'Codebase Trail installation failed: %s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-launch) NO_LAUNCH=1; shift ;;
    --app-archive)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail '--app-archive requires a local app archive path.'
      APP_ARCHIVE="$2"; shift 2 ;;
    --help) printf 'Usage: bash install-macos.sh [--no-launch] [--app-archive PATH]\nInstalls a private Node/npm runtime and Codebase Trail for this user. Git is required.\nUse --app-archive with a downloaded release tarball.\n'; exit 0 ;;
    *) printf 'Unknown installer argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || fail 'Use the generated installer from a versioned GitHub release.'
[[ "$APP_SHA256" =~ ^[a-f0-9]{64}$ ]] || fail 'The release installer has no valid app checksum.'
[ "$(uname -s)" = Darwin ] || fail 'This installer supports macOS only.'
OS_VERSION=$(sw_vers -productVersion)
OS_MAJOR=${OS_VERSION%%.*}; OS_REST=${OS_VERSION#*.}; OS_MINOR=${OS_REST%%.*}
[[ "$OS_MAJOR" =~ ^[0-9]+$ && "$OS_MINOR" =~ ^[0-9]+$ ]] || fail 'Could not determine the macOS version.'
[ "$OS_MAJOR" -gt 13 ] || { [ "$OS_MAJOR" -eq 13 ] && [ "$OS_MINOR" -ge 5 ]; } || fail 'macOS 13.5 or newer is required.'
case "$(uname -m)" in
  arm64) ARCH=arm64; NODE_SHA256=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7 ;;
  x86_64) ARCH=x64; NODE_SHA256=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035 ;;
  *) fail 'Supported macOS architectures are Apple Silicon and Intel x64.' ;;
esac
for tool in curl shasum tar git; do command -v "$tool" >/dev/null 2>&1 || fail "Install $tool before running this installer."; done
git --version >/dev/null 2>&1 || fail 'Git is not usable. Install Git separately, then retry.'
[ -z "$APP_ARCHIVE" ] || [ -f "$APP_ARCHIVE" ] || fail 'The local app archive must be an existing file.'
[ -n "${HOME:-}" ] || fail 'HOME is not set.'
ROOT="$HOME/Library/Application Support/Codebase Trail/app"
mkdir -p "$ROOT/versions"
LOCK="$ROOT/.install-lock"
mkdir "$LOCK" 2>/dev/null || fail 'Another installer holds the install lock. Wait for it to finish. A forcibly interrupted install may need its lock removed manually.'
STAGE=''
cleanup() { [ -z "$STAGE" ] || rm -rf "$STAGE"; rmdir "$LOCK"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
DESTINATION="$ROOT/versions/v$APP_VERSION-${APP_SHA256:0:12}"
if [ -e "$DESTINATION" ]; then
  [ -f "$DESTINATION/.complete" ] && [ "$(cat "$DESTINATION/.complete")" = "$APP_SHA256" ] || fail 'An incomplete installation already occupies this version. It has not been modified.'
  [ "$("$DESTINATION/node/bin/node" --version)" = "v$NODE_VERSION" ] || fail 'The existing private runtime is invalid. It has not been modified.'
  "$DESTINATION/node/bin/node" "$DESTINATION/app/node_modules/codebase-trail/launcher.mjs" --help >/dev/null
else
  STAGE=$(mktemp -d "$ROOT/.staging.XXXXXX")
  download() { curl --fail --show-error --silent --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --max-time 600 "$1" --output "$2"; }
  verify() { [ "$(shasum -a 256 "$1" | cut -d ' ' -f 1)" = "$2" ] || fail 'A downloaded archive failed SHA-256 verification. Nothing was activated.'; }
  NODE_ARCHIVE="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  download "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ARCHIVE" "$STAGE/node.tar.gz"
  verify "$STAGE/node.tar.gz" "$NODE_SHA256"
  if [ -n "$APP_ARCHIVE" ]; then
    cp -- "$APP_ARCHIVE" "$STAGE/app.tgz"
  else
    download "https://github.com/$APP_REPOSITORY/releases/download/v$APP_VERSION/codebase-trail-$APP_VERSION.tgz" "$STAGE/app.tgz"
  fi
  verify "$STAGE/app.tgz" "$APP_SHA256"
  mkdir "$STAGE/node"
  tar -xzf "$STAGE/node.tar.gz" -C "$STAGE/node" --strip-components=1
  [ "$("$STAGE/node/bin/node" --version)" = "v$NODE_VERSION" ] || fail 'The downloaded runtime did not report its pinned version.'
  : > "$STAGE/npmrc"; : > "$STAGE/global-npmrc"
  PATH="$STAGE/node/bin:$PATH" "$STAGE/node/bin/node" "$STAGE/node/lib/node_modules/npm/bin/npm-cli.js" install \
    --prefix "$STAGE/app" "$STAGE/app.tgz" --omit=dev --ignore-scripts --no-audit --no-fund \
    --cache "$ROOT/npm-cache" --userconfig "$STAGE/npmrc" --globalconfig "$STAGE/global-npmrc" --registry https://registry.npmjs.org
  "$STAGE/node/bin/node" "$STAGE/app/node_modules/codebase-trail/launcher.mjs" --help >/dev/null
  "$STAGE/node/bin/node" --input-type=module - "$STAGE/app/node_modules/codebase-trail" <<'JS'
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { parseSource } = await import(pathToFileURL(join(process.argv[2], 'syntax-analysis.mjs')).href);
if (!parseSource('check.js', 'export const value = 1;')) throw new Error('Native parser validation failed');
JS
  rm "$STAGE/node.tar.gz" "$STAGE/app.tgz" "$STAGE/npmrc" "$STAGE/global-npmrc"
  printf '%s\n' "$APP_SHA256" > "$STAGE/.complete"
  mv "$STAGE" "$DESTINATION"
  STAGE=''
fi
STAGE=$(mktemp -d "$ROOT/.staging.XXXXXX")
printf '#!/bin/bash\nexport PATH=%q:"$PATH"\nexec %q %q "$@"\n' "$DESTINATION/node/bin" "$DESTINATION/node/bin/node" "$DESTINATION/app/node_modules/codebase-trail/launcher.mjs" > "$STAGE/launcher"
chmod 700 "$STAGE/launcher"
mv "$STAGE/launcher" "$ROOT/codebase-trail"
printf 'Installed Codebase Trail %s. Launch again with:\n"%s"\n' "$APP_VERSION" "$ROOT/codebase-trail"
cleanup
STAGE=''
trap - EXIT
if [ "$NO_LAUNCH" -eq 0 ]; then "$ROOT/codebase-trail"; fi
