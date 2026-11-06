#!/usr/bin/env bash
# Builds the Claude Desktop bundle (dist/nz-legislation-mcp.mcpb) from the npm package contents,
# with production dependencies installed exactly as locked. Run from the repository root.
# No third-party tool runs here: a .mcpb file is a zip archive with manifest.json at its root,
# so the standard `zip` command builds it. scripts/check-mcpb.sh (CI only) checks the result
# against the official mcpb CLI.
#
# Usage: scripts/build-mcpb.sh [package.tgz]
#   With a tarball (the one being published to npm), the bundle is built from exactly that.
#   Without one, it runs "pnpm pack" (run "pnpm build" first).
#   MCPB_KEEP_STAGE=<dir>: also copy the staged folder to <dir> (used by check-mcpb.sh).
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
rm -rf "$stage/node_modules/.pnpm"

# 3. The bundle manifest (generated and drift-tested by scripts/distribution.ts).
cp packaging/mcpb/manifest.json "$stage/manifest.json"
if [[ -n "${MCPB_KEEP_STAGE:-}" ]]; then cp -a "$stage" "$MCPB_KEEP_STAGE"; fi

# 4. The bundle: maximum compression, Unix permissions kept, no directory entries or extra
#    attributes. Excluded: the same files the mcpb CLI leaves out (its EXCLUDE_PATTERNS in
#    @anthropic-ai/mcpb 2.1.2); in zip patterns "*" also matches "/", so "*.x" means any depth,
#    and each root-only name is paired with a "*/name" form for nested copies.
excludes=()
for name in .DS_Store Thumbs.db .gitignore .mcpbignore .npmrc .yarnrc .eslintrc .editorconfig \
  .prettierrc .prettierignore .eslintignore .nycrc .babelrc package-lock.json yarn.lock \
  tsconfig.json; do
  excludes+=("$name" "*/$name")
done
for dir in .git .npm .yarn; do excludes+=("$dir/*" "*/$dir/*"); done
excludes+=('.env*' '*/.env*' '.pnp.*' '*/.pnp.*' 'npm-debug.log*' '*/npm-debug.log*'
  'yarn-debug.log*' '*/yarn-debug.log*' 'yarn-error.log*' '*/yarn-error.log*'
  '*.log' '*.map' '*.mcpb' '*.d.ts' '*.tsbuildinfo'
  'node_modules/.cache/*' 'node_modules/.bin/*')

out="$root/dist/nz-legislation-mcp.mcpb"
mkdir -p "$root/dist"
rm -f "$out"
(cd "$stage" && zip -q -r -9 -X -D "$out" . -x "${excludes[@]}")
