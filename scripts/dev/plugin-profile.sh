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
REGISTRY="${DSH_VENDOR_REGISTRY:-https://registry.npmjs.org}"
VENDOR_STORE="$ROOT/vendor/pnpm-store"
VENDOR_PACKAGES="$ROOT/vendor/packages"
TRACE_TARBALL="dsh-trace-waterfall-6c73e9a0.tar.gz"
TRACE_INTEGRITY="sha512-GkJtcZBMswnklx6ybYzOH3+dGfBdXXaOy/pXjaRga7ydM8iGuHcQpfwJo55CP+Kb+RPflaR6d3wQ5SL/S1CREw=="

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

edit_lockfile() {
  local action="$1"
  python3 - "$action" "$PROFILE_DIR/pnpm-lock.yaml" "$PKG_NAME" "$PROFILE_DIR" "$ROOT" <<'PY'
import os, re, sys
from pathlib import Path

action, lockfile, pkg, profile_dir, root = sys.argv[1:6]
path = Path(lockfile)
text = path.read_text()

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


# Install the profile. A fresh profile uses the committed vendor store; an
# existing profile keeps its current store so a hot link update stays a relink.
pnpm_install_profile() {
  local args=(--frozen-lockfile --offline --trust-lockfile)
  if [ ! -d "$PROFILE_DIR/node_modules" ] && [ -d "$VENDOR_STORE" ]; then
    args+=(--store-dir "$VENDOR_STORE")
  fi
  ( cd "$PROFILE_DIR" && pnpm install "${args[@]}" )
}

vendor_install() {
  require_profile
  [ -d "$VENDOR_PACKAGES" ] || {
    echo "vendor packages missing: $VENDOR_PACKAGES" >&2
    exit 1
  }
  local start; start=$(now)
  mkdir -p "$PROFILE_DIR/vendor"

  cp "$VENDOR_PACKAGES/feng0531-dsh-code-review-0.92.3.tgz" \
    "$PROFILE_DIR/vendor/@feng0531-dsh-code-review-0.92.3.tgz"
  cp "$VENDOR_PACKAGES/wingsky-1-dsh-mcp-manager-0.2.9.tgz" \
    "$PROFILE_DIR/vendor/@wingsky-1-dsh-mcp-manager-0.2.9.tgz"
  cp "$VENDOR_PACKAGES/dsh-vscode-file-links-0.1.0.tgz" \
    "$PROFILE_DIR/vendor/dsh-vscode-file-links-0.1.0.tgz"
  cp "$VENDOR_PACKAGES/dsh-webview-clipboard-0.2.1.tgz" \
    "$PROFILE_DIR/vendor/dsh-webview-clipboard-0.2.1.tgz"
  cp "$VENDOR_PACKAGES/$TRACE_TARBALL" "$PROFILE_DIR/vendor/$TRACE_TARBALL"

  rm -rf "$PROFILE_DIR/vendor/dsh-vscode-open-external"
  mkdir -p "$PROFILE_DIR/vendor/dsh-vscode-open-external"
  tar -xzf "$VENDOR_PACKAGES/dsh-vscode-open-external-0.1.0.tgz" \
    -C "$PROFILE_DIR/vendor/dsh-vscode-open-external" --strip-components=1

  python3 - "$PROFILE_DIR" "$TRACE_TARBALL" "$TRACE_INTEGRITY" <<'PY'
import json, sys
from pathlib import Path

profile = Path(sys.argv[1])
tarball = sys.argv[2]
integrity = sys.argv[3]
spec = f'file:vendor/{tarball}'

manifest = profile / 'package.json'
data = json.loads(manifest.read_text())
deps = data.setdefault('dependencies', {})
changed = deps.get('dsh-trace-waterfall') != spec
deps['dsh-trace-waterfall'] = spec
manifest.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

lock = profile / 'pnpm-lock.yaml'
text = lock.read_text()
old_url = 'https://codeload.github.com/omdsh-dev/dsh-trace-waterfall/tar.gz/6c73e9a0a85d1ded06b088e0f1435d15dc278660'
text = text.replace('github:omdsh-dev/dsh-trace-waterfall', spec)
text = text.replace(old_url, spec)
text = text.replace(
    'resolution: {gitHosted: true, integrity: ' + integrity + ', tarball: ' + spec + '}',
    'resolution: {integrity: ' + integrity + ', tarball: ' + spec + '}',
)
lock.write_text(text)
print(f'vendor-install: trace-waterfall -> {spec} (manifest changed: {changed})')
PY

  echo "[vendor-install] packages copied in $(duration "$start" "$(now)")"
  echo "[vendor-install] pnpm frozen offline install"
  pnpm_install_profile
  echo "[vendor-install] total $(duration "$start" "$(now)")"
}

install() {
  require_profile
  vendor_install
  local start; start=$(now)
  edit_manifest install
  edit_lockfile install
  echo "[install] pnpm frozen offline install"
  pnpm_install_profile
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
  pnpm_install_profile
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
  echo "vendor packages: $(find "$VENDOR_PACKAGES" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ') at $VENDOR_PACKAGES"
  if [ -d "$VENDOR_STORE" ]; then
    echo "vendor store: $(du -sh "$VENDOR_STORE" | awk '{print $1}') at $VENDOR_STORE"
  else
    echo "vendor store: missing at $VENDOR_STORE"
  fi
}

vendor() {
  require_profile
  local fetch_dir; fetch_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-cowork-vendor.XXXXXX")
  trap 'rm -rf "$fetch_dir"' EXIT
  cp "$PROFILE_DIR/package.json" "$fetch_dir/package.json"
  cp "$PROFILE_DIR/pnpm-lock.yaml" "$fetch_dir/pnpm-lock.yaml"
  [ -f "$PROFILE_DIR/pnpm-workspace.yaml" ] && cp "$PROFILE_DIR/pnpm-workspace.yaml" "$fetch_dir/pnpm-workspace.yaml"
  [ -d "$PROFILE_DIR/vendor" ] && cp -R "$PROFILE_DIR/vendor" "$fetch_dir/vendor"
  mkdir -p "$VENDOR_STORE"
  local start; start=$(now)
  echo "[vendor] pnpm fetch from $REGISTRY"
  ( cd "$fetch_dir" && pnpm fetch --frozen-lockfile --trust-lockfile \
      --store-dir "$VENDOR_STORE" --registry "$REGISTRY" --reporter append-only )
  echo "[vendor] total $(duration "$start" "$(now)")"
  du -sh "$VENDOR_STORE"
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
  vendor) vendor ;;
  vendor-install) vendor_install ;;
  hot) hot ;;
  *) echo "usage: $0 {install|uninstall|status|vendor|vendor-install|hot}" >&2; exit 2 ;;
esac
