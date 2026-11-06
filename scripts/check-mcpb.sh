#!/usr/bin/env bash
# CI only, never in a release: checks the Claude Desktop bundle against the official mcpb CLI.
# Builds the bundle with scripts/build-mcpb.sh, validates its manifest.json against the bundle
# schema, packs the same staged folder with `mcpb pack`, and compares the two archives' files
# and permissions. Any drift between our zip step and the CLI's packing rules fails CI.
#
# Usage: scripts/check-mcpb.sh [package.tgz]   (same argument as build-mcpb.sh)
set -euo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

MCPB_KEEP_STAGE="$work/stage" scripts/build-mcpb.sh "$@"

# The CLI is pinned to an exact version and run with install scripts disabled. It stays out of
# the lockfile and the release because its dependency tree has open audit findings.
mcpb() { npm_config_ignore_scripts=true npx -y @anthropic-ai/mcpb@2.1.2 "$@"; }
mcpb validate "$work/stage/manifest.json"
mcpb pack "$work/stage" "$work/reference.mcpb" >/dev/null

# "permissions path" for each file entry. zipinfo prints eight fields before the name
# ("-rw-r--r--  3.0 unx  size tx defN date time path"); stripping them keeps names with spaces.
list() {
  zipinfo "$1" | awk '$3 == "unx" && $NF !~ /\/$/ {
    perms = substr($1, 2, 9); name = $0; sub(/^([^ ]+ +){8}/, "", name); print perms, name
  }' | LC_ALL=C sort
}
ours="$(list dist/nz-legislation-mcp.mcpb)"
reference="$(list "$work/reference.mcpb")"
if [[ "$ours" != "$reference" ]]; then
  echo "The bundle differs from what mcpb pack produces (< ours, > mcpb pack):" >&2
  diff <(echo "$ours") <(echo "$reference") >&2 || true
  exit 1
fi
if [[ -z "$ours" ]]; then
  echo "No files found in the bundle listing." >&2
  exit 1
fi
echo "Bundle matches mcpb pack: $(echo "$ours" | wc -l) files, same permissions."
