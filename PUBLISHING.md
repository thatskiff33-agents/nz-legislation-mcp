# Publishing a release

Releases are prepared automatically. Merging the release pull request is the decision to
release. The publishing jobs then wait 30 minutes on the `release` environment, so a mistaken
run can be cancelled from the Actions page before anything leaves GitHub.

## How a release works

1. Every merge to `main` updates a release pull request opened by release-please. It holds the
   next version number (from the conventional commit types since the last release) and the
   changelog. The version is set in `package.json` and in every generated manifest
   (`server.json`, the Claude Code plugin and the Claude Desktop bundle). A test checks that
   none is missed.
2. Merging the release pull request creates the Git tag and a **draft** GitHub release. The tag
   is public at once; the GitHub release is not visible until step 4.
3. Build, then publish:
   - `pack` (no publishing rights) runs `pnpm check` and packs the npm tarball. No new step or
     tool starts after packing other than the artifact upload. The tarball's name and SHA-256
     are passed to later jobs as job outputs, which no later job can change, and printed in the
     job summary.
   - `bundle-build` (no publishing rights) verifies the tarball against that checksum and builds
     the Claude Desktop bundle from it with the standard `zip` command: no third-party tool runs
     in a release. It cannot change what npm publishes: tampering with the tarball artifact fails
     the checksum check and stops the release.
   - The publishing jobs then wait out the `release` environment's 30-minute timer: npm, the
     bundle, the two container builds and, once those finish, the container merge (which waits
     again). Cancelling the workflow run during a wait stops the release before that job
     publishes. The npm and bundle jobs install nothing, run no project tooling, and
     verify every file against the job-output checksums before using it:
     - npm: publishes the checked tarball with provenance, using trusted publishing (no npm
       token is stored).
     - Claude Desktop bundle: attached to the draft GitHub release with SHA-256 checksums.
     - Container: each architecture (`linux/amd64`, `linux/arm64`) is built from the release tag
       on its own native runner (inside BuildKit, without access to the publishing credentials),
       scanned, and pushed by digest with an SBOM and provenance. A merge job then tags the
       multi-architecture image on `ghcr.io/thatskiff33/nz-legislation-mcp` and signs it with
       cosign (keyless). The digests are printed in the job summaries.
4. `publish-release` publishes the draft GitHub release once npm, the bundle and the container
   have all succeeded.
5. After npm has the new version, publish to the MCP Registry by hand (see below).

The Claude Code plugin is served straight from this repository, so it updates when `main`
changes. It runs a pinned `npx -y nz-legislation-mcp@<version>`, so it only works once that
version is on npm. release-please cannot edit part of a string, so a small job
(`scripts/sync-release-files.mjs`) updates the pin in each release pull request.

## Known limits

- A `.mcpb` bundle is a zip archive with `manifest.json` at its root, so `scripts/build-mcpb.sh`
  builds it with `zip`, leaving out the same files the official `@anthropic-ai/mcpb` CLI does.
  The CLI itself (2.1.2, pinned, install scripts disabled) never runs in a release, because its
  dependency tree has open audit findings and is resolved fresh by `npx`. It runs only in CI's
  `claude desktop bundle` job, which publishes nothing: `scripts/check-mcpb.sh` validates the
  manifest with it and checks that our bundle has the same files and permissions as `mcpb pack`
  would produce (#37). Before the first release, install the bundle in Claude Desktop by hand
  (#11) to confirm it end to end.

## If a release fails part-way

The GitHub release stays a draft until npm, the bundle and the container are all out, so no
half-finished GitHub release is shown. npm and the container wait for the bundle build, so a
failed build or bundle stops everything before anything is published.

**Keep the tag.** release-please finds the previous release by its tag. Deleting the tag makes it
rebuild the changelog from the whole history. (This, and the skipped version number below, come
from reading release-please 17.6.0's code; to confirm on the first real release.)

Each publishing job waits on its own timer, so a cancelled run may have published some jobs
already. Use the second case below if npm published, even if another job failed or was
cancelled.

- **Build or bundle failed, or the run was cancelled before any publishing job ran:** nothing
  was published.
  - If re-running the failed jobs from the workflow run can fix it, do that.
  - Otherwise, delete only the draft release (`gh release delete <tag>`, without
    `--cleanup-tag`), fix the problem on `main`, and release again. The next release pull
    request is for the next version; the failed version number is skipped.
- **npm published, but a later job failed or was cancelled:** npm versions cannot be reused.
  Re-run the failed jobs from the workflow run; the bundle upload replaces any partly uploaded assets.
  - If a re-run is not possible, download the `npm-tarball` and `desktop-bundle` artifacts from
    the run.
  - Check each file against the SHA-256 printed in the `pack` and `bundle-build` job summaries.
  - Write `SHA256SUMS` for the two files, attach the bundle and `SHA256SUMS` to the draft, then
    publish it (`gh release edit <tag> --draft=false`).
- **A container build failed, or the merge was cancelled:** the image built by any finished leg
  is already in the registry by digest, but untagged and unsigned, so nothing points users at it.
  Re-run the failed jobs (each leg replaces its digest record; the merge checks there are exactly
  two). If the release is abandoned, delete the untagged versions from the package's page on
  GitHub.

## One-time setup (before the first release)

Do these in order. Each one is an outward-facing change, made by a maintainer or with the
owner's approval.

Status on 7 November 2026: steps 1 to 6 are done (#53, #11). Step 7 follows the first release.

1. Release App: release-please and the plugin-pin job write with a dedicated GitHub App, not
   the workflow's own token. Only the App may then create release tags (step 5), and the release
   pull requests and commits it makes start CI like any other.
   - Your GitHub settings, Developer settings, GitHub Apps, New GitHub App: any name (for
     example `nz-legislation-mcp-release`), the repository URL as the homepage, Webhook
     "Active" unticked, repository permissions Contents read and write and Pull requests read
     and write (Metadata read-only is added automatically), installable only on this account.
   - Install it on this repository only.
   - Repository settings, Environments: create `release-pr` with no reviewers, limited to the
     `main` branch. In it, add the App's client ID as the environment variable
     `RELEASE_APP_CLIENT_ID` and a newly generated private key as the environment secret
     `RELEASE_APP_PRIVATE_KEY`. Keeping the key in this environment (not as a repository
     secret) means only the release jobs on `main` can read it, never a branch or pull request.
     Delete the downloaded `.pem` file once it is stored.
   - To rotate the key: generate a new one on the App's page, replace the environment secret,
     then delete the old key on the App's page.
   - The workflow token stays read-only for these jobs, so "Allow GitHub Actions to create and
     approve pull requests" is not needed.
2. Repository settings, Environments: create `release`, limited to the `main` branch and `v*`
   tags, with no required reviewers and a 30-minute wait timer (owner decision, 7 November 2026).
   "Allow administrators to bypass configured protection rules" is off (set by the agent on 7
   November 2026 under the owner's approval for the release settings, so the timer binds
   everyone). The timer is the cancel window. An agent may merge the release pull request once its CI is
   green and an independent review has signed off (AGENTS.md).
3. npm: sign in to the account that will own `nz-legislation-mcp` and turn on two-factor
   authentication for authorisation and writes.
4. npm trusted publisher. npm only accepts one for a package that already exists ("The package
   you're configuring must already exist on the npm registry", `npm trust` documentation), so:
   - Claim the name with a placeholder that holds a README and no code: from a folder outside
     this repository, `npm publish --access public --tag placeholder` for version
     `0.0.0-placeholder.0`, approving the two-factor prompt in the browser. On 6 November 2026
     the registry also showed a `0.0.0-stage` holding version, created a few minutes before the
     placeholder appeared (observed; cause to confirm). Deprecate both (`npm deprecate`), saying they have no
     code.
   - Add the trusted publisher (npm 11.15.0 or later), or use the package's settings page on
     npmjs.com with the same owner, repository, workflow and environment:

     ```sh
     npm trust github nz-legislation-mcp --file release.yml --repo thatskiff33/nz-legislation-mcp --env release --allow-publish
     ```

     Then `npm logout`, so no npm credential stays on the computer.

   - A new trusted publisher must complete a successful publish within 2 days or it expires,
     so add it shortly before releasing. If it expires, remove it (`npm trust list`, then
     `npm trust revoke --id <id>`) and add it again.
   - Trusted publishing needs npm 11.5.1 or later (the workflow publishes with Node 24's npm).
   - After the first release publishes from CI: the package's settings, Publishing access,
     "Require two-factor authentication and disallow tokens".
5. Repository settings, Rules, New tag ruleset: target tags matching `v*`, enforcement
   active, rules "Restrict creations", "Restrict updates" and "Restrict deletions", and add the
   release App (step 1) as the only bypass actor, with bypass mode "Always allow" ("For pull requests only" would block tag creation). Release tags can then only be created with the
   App's key (held only by the release jobs on `main`) and never moved or deleted. GitHub Actions itself cannot be a bypass actor,
   which is why the App is needed (#53). On the first release, check that the tag appears
   before the draft release and that the `pack` job checks it out; record the result on #53.
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

## Checks before merging the release pull request

- The release pull request's changelog reads correctly.
- CI is green on the release commit, including the "pin the Claude Code plugin" commit. Both
  are pushed by the release App, so CI starts on its own and `main`'s required checks apply.
- `docs/clients.md` and the README quick start still match the release.
- The release pull request includes the "pin the Claude Code plugin" commit (the
  `sync-release-pr` job adds it a minute or so after release-please updates the pull request).
  If it is merged without it, the tag and a draft GitHub release are still created, but the
  `pack` job fails its pin check and nothing is published. Fix the pin on `main` and release
  again, keeping the tag (see "If a release fails part-way").
