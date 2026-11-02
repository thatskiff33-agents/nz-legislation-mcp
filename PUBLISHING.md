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
3. Three publishing jobs then wait for approval on the `release` environment:
   - npm: `pnpm check`, then `npm publish` with provenance, using trusted publishing (no npm
     token is stored).
   - Claude Desktop bundle: built from the npm package contents and attached to the GitHub
     release with a SHA-256 checksum.
   - Container: scanned, then pushed to `ghcr.io/thatskiff33-agents/nz-legislation-mcp`
     with an SBOM and provenance, and signed with cosign (keyless).
4. After npm has the new version, publish to the MCP Registry by hand (see below).

The Claude Code plugin is served straight from this repository, so it updates when `main`
changes. It runs `npx -y nz-legislation-mcp`, so it only works once the package is on npm.

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
   `release.yml` and environment `release`.
   - To confirm: whether npm lets you add a trusted publisher before the package exists. If it
     does not, publish the first version by hand from a clean checkout of the release tag
     (`pnpm install --frozen-lockfile && pnpm check && npm publish --access public`), then add
     the trusted publisher, and from then on disallow token publishing in the package settings.
5. GitHub Container Registry: after the first image is pushed, set the package's visibility to
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
- CI is green on the release commit. (Pull requests opened by release-please with the default
  token do not start CI; push an empty commit to the release branch, or rerun CI, if needed.)
- `docs/clients.md` and the README quick start still match the release.
