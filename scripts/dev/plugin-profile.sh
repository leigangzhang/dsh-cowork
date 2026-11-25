#!/usr/bin/env bash
# Unified local lifecycle for the cowork plugin in a DSH profile.
#
# The profile keeps a link: dependency to this checkout, so changing the plugin
# means rebuilding lib/ and restarting the host. No tarball repack, no lockfile
# re-resolution, and no full node_modules relink are needed for hot updates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE_NAME="${DSH_PROFILE:-web}"
if [ -n "${DSH_PROFILE:-}" ]; then
  PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE_NAME"
else
  PROFILE_DIR="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/$PROFILE_NAME}"
fi
PKG_NAME="@dsh-external/dsh-cowork"
LINK_SPEC="link:$ROOT"

now() { python3 -c 'import time;print(time.time())'; }
duration() { python3 -c "print(f'{float('$2') - float('$1'):.2f}s')"; }

require_profile() {
  [[ -f "$PROFILE_DIR/package.json" && -f "$PROFILE_DIR/pnpm-lock.yaml" ]] || {
    echo "profile not found: $PROFILE_DIR" >&2
    exit 1
  }
  case "$PROFILE_DIR" in
    "$HOME/.dsh/profiles/"*) ;;
    *) echo "refusing to modify profile outside $HOME/.dsh/profiles: $PROFILE_DIR" >&2; exit 1 ;;
  esac
}

edit_manifest() {
  local action="$1"
  python3 - "$action" "$PROFILE_DIR/package.json" "$PKG_NAME" "$LINK_SPEC" <<'PY'
import json, sys
from pathlib import Path

action, manifest, pkg, link = sys.argv[1:5]
path = Path(manifest)
data = json.loads(path.read_text())
deps = data.setdefault('dependencies', {})
profile = data.setdefault('dsh', {}).setdefault('profile', {})
bundles = profile.setdefault('bundles', [])

if action == 'install':
    deps[pkg] = link
    if pkg not in bundles:
        try:
            at = bundles.index('dsh-command-agentteam-run-audit')
        except ValueError:
            at = len(bundles)
        bundles.insert(at, pkg)
else:
    deps.pop(pkg, None)
    profile['bundles'] = [entry for entry in bundles if entry != pkg]

path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print(f'{action}: package.json updated')
PY
}

# Profile assumption: pnpm v9 lockfile (lockfileVersion '9.0'). The bundle
# anchor is optional; a profile without it appends the entry at the end.
edit_lockfile() {
  local action="$1"
  python3 - "$action" "$PROFILE_DIR/pnpm-lock.yaml" "$PKG_NAME" "$PROFILE_DIR" "$ROOT" <<'PY'
import os, re, sys
from pathlib import Path

action, lockfile, pkg, profile_dir, root = sys.argv[1:6]
path = Path(lockfile)
text = path.read_text()
if not text.startswith("lockfileVersion: '9.0'"):
    raise SystemExit('unsupported pnpm lockfile: expected lockfileVersion 9.0')

# Importer entry: six-space key inside importers.
importer = re.compile(
    rf"^      '{re.escape(pkg)}':\n(?:        [^\n]*\n)+",
    re.MULTILINE,
)
text = importer.sub('', text)

# Tarball snapshots can survive a switch from file: to link:.
snapshot = re.compile(
    rf"^  '{re.escape(pkg)}@file:[^\n]*:\n(?:    [^\n]*\n)*(?:\n)?",
    re.MULTILINE,
)
text = snapshot.sub('', text)
dep_snapshot = re.compile(
    rf"^  '{re.escape(pkg)}@file:[^\n]*\([^\n]*\):\n(?:    [^\n]*\n)*(?:\n)?",
    re.MULTILINE,
)
text = dep_snapshot.sub('', text)

if action == 'install':
    relative = os.path.relpath(root, profile_dir)
    block = (
        f"      '{pkg}':\n"
        f"        specifier: link:{root}\n"
        f"        version: link:{relative}\n"
    )
    marker = '    dependencies:\n'
    at = text.find(marker)
    if at == -1:
        raise SystemExit('lockfile importer has no dependencies section')
    at += len(marker)
    text = text[:at] + block + text[at:]

path.write_text(text)
print(f'{action}: lockfile updated')
PY
}

install() {
  require_profile
  local start; start=$(now)
  edit_manifest install
  edit_lockfile install
  echo "[install] pnpm frozen offline install"
  ( cd "$PROFILE_DIR" && pnpm install --frozen-lockfile --offline --trust-lockfile )
  echo "[install] total $(duration "$start" "$(now)")"
}

uninstall() {
  require_profile
  local start; start=$(now)
  edit_manifest uninstall
  edit_lockfile uninstall
  local target="$PROFILE_DIR/node_modules/$PKG_NAME"
  if [ -L "$target" ]; then
    rm -f "$target"
  elif [ -e "$target" ]; then
    echo "refusing to remove non-symlink plugin directory: $target" >&2
    exit 1
  fi
  echo "[uninstall] pnpm frozen offline install"
  ( cd "$PROFILE_DIR" && pnpm install --frozen-lockfile --offline --trust-lockfile )
  echo "[uninstall] total $(duration "$start" "$(now)")"
}

status() {
  require_profile
  python3 - "$PROFILE_DIR" "$PKG_NAME" "$ROOT" <<'PY'
import json, os, sys
from pathlib import Path
profile, pkg, root = sys.argv[1:4]
data = json.loads(Path(profile, 'package.json').read_text())
bundles = ((data.get('dsh') or {}).get('profile') or {}).get('bundles') or []
target = Path(profile, 'node_modules', pkg)
print('profile:', profile)
print('dependency:', (data.get('dependencies') or {}).get(pkg))
print('bundle listed:', pkg in bundles)
print('installed link:', os.path.realpath(target) if target.exists() else 'missing')
print('expected target:', root)
package = target / 'package.json'
if package.exists():
    print('package version:', json.loads(package.read_text()).get('version'))
lib = target / 'lib/platform/artifact-files.js'
print('sandbox policy fix:', 'sandboxPolicy' in lib.read_text() if lib.exists() else 'lib missing')
PY
}

hot() {
  local start; start=$(now)
  echo "[hot] npm run build"
  ( cd "$ROOT" && npm run build )
  echo "[hot] build $(duration "$start" "$(now)")"
  status
}

case "${1:-status}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  hot) hot ;;
  *) echo "usage: $0 {install|uninstall|status|hot}" >&2; exit 2 ;;
esac
