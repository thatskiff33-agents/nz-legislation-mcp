#!/usr/bin/env bash
# Builds the Claude Desktop bundle (dist/nz-legislation-mcp.mcpb) from the npm package contents,
# with production dependencies installed exactly as locked. Run from the repository root after
# "pnpm build". Usage: scripts/build-mcpb.sh
set -euo pipefail

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. The files npm would publish (package.json "files"), so the bundle matches the npm release.
pnpm pack --pack-destination "$work" >/dev/null
tar -xzf "$work"/*.tgz -C "$work"
stage="$work/package"

# 2. Production dependencies from the lockfile, with the same supply-chain settings, flat
#    (no symlinks, which a zip bundle cannot hold) and no install scripts.
cp pnpm-lock.yaml pnpm-workspace.yaml "$stage/"
(cd "$stage" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted >/dev/null)
rm "$stage/pnpm-lock.yaml" "$stage/pnpm-workspace.yaml"

# 3. The bundle manifest, then validate and pack (mcpb CLI pinned to an exact version).
cp packaging/mcpb/manifest.json "$stage/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 validate "$stage/manifest.json"
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" "$root/dist/nz-legislation-mcp.mcpb"
