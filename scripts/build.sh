#!/bin/bash
# Build the host half: link dependencies, then compile src/ → lib/.
#
# The installed DSH app ships runtime only (no .d.ts), so types come from a DSH
# source checkout built by its own tsc, while runtime links point at the app.
# No caller-supplied DSH_CHECKOUT is required on a machine with either path;
# set DSH_CHECKOUT / DSH_APP_NODE_MODULES only for a non-default layout.
#
# Usage: bash scripts/build.sh [--no-emit]   (--no-emit = typecheck only)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

find_checkout() {
  if [ -n "${DSH_CHECKOUT:-}" ] && [ -d "$DSH_CHECKOUT/packages" ]; then
    printf '%s\n' "$DSH_CHECKOUT"
    return 0
  fi
  for candidate in \
    "$HOME/Workspace/deepseek-harness" \
    "$HOME/deepseek-harness" \
    "$HOME/dsh-harness" \
    "$HOME/dsh" \
    "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

CHECKOUT="$(find_checkout || true)"
if [ -z "$CHECKOUT" ]; then
  echo "build: no DSH source checkout with packages/ found; set DSH_CHECKOUT" >&2
  exit 1
fi

APP_NODE_MODULES="${DSH_APP_NODE_MODULES:-/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules}"
if [ ! -d "$APP_NODE_MODULES/@deepseek-ai" ]; then
  echo "build: DSH app node_modules not found at $APP_NODE_MODULES; set DSH_APP_NODE_MODULES" >&2
  exit 1
fi

types_dir() {
  case "$1" in
    cordis) echo "vendor/cordis" ;;
    schemastery) echo "vendor/schemastery" ;;
    dsh-tools) echo "packages/core/tools" ;;
    dsh-host-webserver) echo "packages/host/webserver" ;;
    dsh-atomic-write) echo "packages/util/atomic-write" ;;
    *) return 1 ;;
  esac
}

PACKAGES="cordis schemastery dsh-tools dsh-host-webserver dsh-atomic-write"

REFS=""
for package in $PACKAGES; do
  REFS="$REFS $CHECKOUT/$(types_dir "$package")"
done

echo "=== build: compiling DSH declarations from $CHECKOUT ==="
"$CHECKOUT/node_modules/.bin/tsc" -b $REFS

mkdir -p node_modules/@deepseek-ai node_modules/.dsh-types/@deepseek-ai node_modules/@types node_modules/.bin
for package in $PACKAGES; do
  # rm first: a stale symlink must never be written through.
  rm -rf "node_modules/@deepseek-ai/$package"
  ln -s "$APP_NODE_MODULES/@deepseek-ai/$package" "node_modules/@deepseek-ai/$package"
  rm -rf "node_modules/.dsh-types/@deepseek-ai/$package"
  ln -s "$CHECKOUT/$(types_dir "$package")" "node_modules/.dsh-types/@deepseek-ai/$package"
done
rm -rf node_modules/@types/node
ln -s "$CHECKOUT/node_modules/@types/node" node_modules/@types/node

# The client half typechecks against React types only; the runtime `react`
# module comes from the host's module table at load time (kept external in
# scripts/build-client.mjs), so no react package is linked here.
TYPES_REACT_DIR="$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name '@types+react@*' | head -n 1)"
if [ -z "$TYPES_REACT_DIR" ]; then
  echo "build: @types/react not found under $CHECKOUT/node_modules/.pnpm; the client half cannot be typechecked" >&2
  exit 1
fi
rm -rf node_modules/@types/react
ln -s "$TYPES_REACT_DIR/node_modules/@types/react" node_modules/@types/react

if [ -d "$CHECKOUT/node_modules/.pnpm" ]; then
  STANDARD_SCHEMA_DIR="$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name '@standard-schema+spec@*' | head -n 1)"
  if [ -n "$STANDARD_SCHEMA_DIR" ]; then
    mkdir -p node_modules/@standard-schema
    rm -rf node_modules/@standard-schema/spec
    ln -s "$STANDARD_SCHEMA_DIR/node_modules/@standard-schema/spec" node_modules/@standard-schema/spec
  fi
fi

# npm scripts prepend node_modules/.bin to PATH: pin the checkout compiler so a
# global tsc version cannot change the result.
rm -f node_modules/.bin/tsc
printf '#!/bin/bash\nexec "%s/node_modules/typescript/bin/tsc" "$@"\n' "$CHECKOUT" > node_modules/.bin/tsc
chmod +x node_modules/.bin/tsc
echo "=== build: type and runtime links ready ==="

if [ "${1:-}" = "--no-emit" ]; then
  echo "=== Typecheck src (host) ==="
  ./node_modules/.bin/tsc -p tsconfig.json --noEmit
  echo "=== Typecheck src/client (browser half) ==="
  ./node_modules/.bin/tsc -p tsconfig.client.json --noEmit
  exit 0
fi

echo "=== Compiling src → lib ==="
rm -rf lib
./node_modules/.bin/tsc -p tsconfig.json
echo "=== Building src/client → lib/client.js ==="
node scripts/build-client.mjs
echo "=== Build complete ==="
