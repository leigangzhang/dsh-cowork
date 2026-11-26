#!/bin/bash
# Build the plugin from the repo's own devDependencies.
#
# Host types and the esbuild binary come from package-lock-managed
# devDependencies, so a fresh clone can build without a local DSH source
# checkout or an installed DSH app.
#
# Usage: bash scripts/build/build.sh [--no-emit]   (--no-emit = typecheck only)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "=== Typecheck src (host) ==="
./node_modules/.bin/tsc -p tsconfig.json --noEmit
echo "=== Typecheck src/client (browser half) ==="
./node_modules/.bin/tsc -p tsconfig.client.json --noEmit

if [ "${1:-}" = "--no-emit" ]; then
  exit 0
fi

echo "=== Compiling src → lib ==="
rm -rf lib
./node_modules/.bin/tsc -p tsconfig.json
echo "=== Building src/client → lib/client.js ==="
node scripts/build/build-client.mjs
echo "=== Build complete ==="
