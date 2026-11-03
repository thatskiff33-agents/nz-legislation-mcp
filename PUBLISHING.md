# Publishing a release

Releases are prepared automatically and published only after a maintainer approves them.
Nothing leaves GitHub until someone approves the `release` environment.

## How a release works

1. Every merge to `main` updates a release pull request opened by release-please. It holds the
   next version number (from the conventional commit types since the last release) and the
   changelog. The version is set in `package.json` and in every generated manifest
   (`server.json`, the Claude Code plugin and the Claude Desktop bundle). A test checks that
   none is missed.
2. Merging the release pull request creates the Git tag and GitHub release.
3. A build job with no publishing rights runs `pnpm check`, packs the npm tarball and builds
   the Claude Desktop bundle from that same tarball. Three publishing jobs then wait for
   approval on the `release` environment. The npm and bundle jobs install nothing and run no
   project tooling:
   - npm: publishes the checked tarball with provenance, using trusted publishing (no npm
     token is stored).
   - Claude Desktop bundle: attached to the GitHub release with SHA-256 checksums.
   - Container: built from the release tag (inside Docker, without access to the publishing
     credentials), scanned, then pushed to `ghcr.io/thatskiff33-agents/nz-legislation-mcp`
     with an SBOM and provenance, and signed with cosign (keyless).
4. After npm has the new version, publish to the MCP Registry by hand (see below).

The Claude Code plugin is served straight from this repository, so it updates when `main`
changes. It runs a pinned `npx -y nz-legislation-mcp@<version>`, so it only works once that
version is on npm. release-please cannot edit part of a string, so a small job
(`scripts/sync-release-files.mjs`) updates the pin in each release pull request.

## Known limits

- The bundle is built with the `@anthropic-ai/mcpb` CLI (2.1.2, pinned, install scripts
  disabled). It is not a dev dependency because its dependency tree has open audit findings;
  it runs only in the build job, which has no write or publishing rights.

## One-time setup (before the first release)

Do these in order. Each one is an outward-facing change, so a maintainer does them by hand.

1. Repository settings, Actions, General: allow GitHub Actions to create and approve pull
   requests (release-please needs this).
2. Repository settings, Environments: create `release`, add required reviewers (the
   maintainers), and limit it to the `main` branch and `v*` tags.
3. npm: sign in to the account that will own `nz-legislation-mcp` and turn on two-factor
   authentication.
4. npm trusted publisher: on the package's settings page, add a GitHub Actions trusted
   publisher with owner `thatskiff33-agents`, repository `nz-legislation-mcp`, workflow
   `release.yml` and environment `release`. Trusted publishing needs npm 11.5.1 or later
   (the workflow publishes with Node 24's npm). A new trusted publisher must complete a
   successful publish within 2 days or it expires, so add it shortly before releasing.
   - To confirm: npm's documentation does not say whether a trusted publisher can be added
     before the package exists (third-party guides say it cannot). If it cannot, publish the
     first version by hand from a clean checkout of the release tag
     (`pnpm install --frozen-lockfile && pnpm check && npm publish --access public`), then add
     the trusted publisher, and from then on disallow token publishing in the package settings.
5. Repository settings, Rules: add a tag ruleset for `v*` that only maintainers can bypass,
   so release tags cannot be created or moved by anyone else.
6. Only when steps 1 to 5 are done: Repository settings, Secrets and variables, Actions,
   Variables: set `RELEASE_ENABLED` to `true`. Until then the release workflow does nothing.
   This matters because GitHub creates a missing environment automatically, with no
   protection, the first time a job uses it.
7. GitHub Container Registry: after the first image is pushed, set the package's visibility to
   public and link it to this repository.

## MCP Registry (manual, after npm)

The registry checks that the npm package belongs to this server through the `mcpName` field in
`package.json`, so publish to npm first.

1. Install the official `mcp-publisher` CLI from the
   [registry releases](https://github.com/modelcontextprotocol/registry/releases) and check its
   checksum.
2. From a clean checkout of the release tag: `mcp-publisher login github`, then
   `mcp-publisher publish`. It reads `server.json`.
3. Check the listing at `https://registry.modelcontextprotocol.io/v0/servers?search=nz-legislation-mcp`.

## Checks before approving

- The release pull request's changelog reads correctly.
- CI is green on the release commit. Pull requests opened by release-please with the default
  token do not start CI, so there is no run to rerun: push an empty commit to the release
  branch to start one.
- `docs/clients.md` and the README quick start still match the release.
- The release pull request includes the "pin the Claude Code plugin" commit (the
  `sync-release-pr` job adds it a minute or so after release-please updates the pull request).
  If it is merged without it, the tag and GitHub release are still created but the build job
  fails its pin check and nothing is published; fix the pin on `main` and release again.
