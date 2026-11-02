#!/usr/bin/env bash
# Builds the Claude Desktop bundle (dist/nz-legislation-mcp.mcpb) from the npm package contents,
# with production dependencies installed exactly as locked. Run from the repository root.
#
# Usage: scripts/build-mcpb.sh [package.tgz]
#   With a tarball (the one being published to npm), the bundle is built from exactly that.
#   Without one, it runs "pnpm pack" (run "pnpm build" first).
set -euo pipefail

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. The files npm publishes (package.json "files"), so the bundle matches the npm release.
if [[ $# -ge 1 ]]; then
  tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  pnpm pack --pack-destination "$work" >/dev/null
  tarball="$(ls "$work"/*.tgz)"
fi
tar -xzf "$tarball" -C "$work"
stage="$work/package"

# 2. Production dependencies from the lockfile, with the same supply-chain settings, flat
#    (no symlinks, which a zip bundle cannot hold) and no install scripts.
cp pnpm-lock.yaml pnpm-workspace.yaml "$stage/"
(cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted >/dev/null)
rm -f "$stage/pnpm-lock.yaml" "$stage/pnpm-workspace.yaml" \
  "$stage/node_modules/.modules.yaml" "$stage"/node_modules/.pnpm-workspace-state*.json

# 3. The bundle manifest, then validate and pack. The mcpb CLI is pinned to an exact version and
#    run with install scripts disabled; it is kept out of devDependencies because its own
#    dependency tree carries audit findings (see PUBLISHING.md).
cp packaging/mcpb/manifest.json "$stage/manifest.json"
mcpb() { npm_config_ignore_scripts=true npx -y @anthropic-ai/mcpb@2.1.2 "$@"; }
mcpb validate "$stage/manifest.json"
mkdir -p "$root/dist"
mcpb pack "$stage" "$root/dist/nz-legislation-mcp.mcpb"
