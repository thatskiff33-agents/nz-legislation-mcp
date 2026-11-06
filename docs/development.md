# Development

## Prerequisites

- Node.js 22 or later (`.nvmrc` pins the minimum).
- pnpm, via Corepack: `corepack enable` (the exact version is pinned in `package.json`). The `pnpm` command must be on your `PATH`, because `pnpm check` calls `pnpm` for each step; `corepack pnpm check` alone is not enough.

## Platforms

`pnpm check` passes on Linux and Windows (macOS is expected to behave as Linux). A few tests need POSIX features (file permission bits, `/dev/null`, `mkfifo`) and are skipped on Windows. The key-file rules they exercise are also covered by platform-independent tests, so coverage stays at 100% on Windows; the non-blocking FIFO open is covered only on POSIX. The 100% coverage gate is enforced in CI, which runs on Linux.

## Commands

| Command           | What it does                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies. Refuses packages younger than 14 days and blocks install scripts.                           |
| `pnpm check`      | Everything CI runs: typecheck, lint, format check, dead-code check (knip), tests with 100% coverage, build.       |
| `pnpm test`       | Tests with coverage.                                                                                              |
| `pnpm test:watch` | Tests in watch mode.                                                                                              |
| `pnpm format`     | Format all files with Prettier.                                                                                   |
| `pnpm build`      | Compile `src/` to `dist/`.                                                                                        |
| `pnpm generate`   | Regenerate the generated files (client docs, plugin, bundle and registry manifests) after changing their sources. |

## Toolchain notes

- TypeScript is pinned to 6.0.x (`~6.0.3`) because `typescript-eslint` supports TypeScript below 6.1 only (its peer range is `>=4.8.4 <6.1.0`). Dependabot ignores TypeScript major updates.
- `@types/node` tracks the minimum supported Node line (22).
- Supply-chain settings live in `pnpm-workspace.yaml`: `minimumReleaseAge` (14 days), `strictDepBuilds` (install scripts fail unless allowed per package), and a time-boxed `audit.ignore` entry tracked in issue #15.

## Continuous integration

All workflows pin actions to full commit SHAs and default to read-only permissions.

- `ci.yml`: `pnpm check` on Node 22 and 24, `pnpm audit`, and a Claude Desktop bundle build.
- `container.yml`: on pull requests that touch the image, builds and scans it with Trivy; when called by `release.yml`, publishes the signed image.
- `release.yml`: release-please and publishing (npm, bundle, container). Off until the owner sets `RELEASE_ENABLED`; see PUBLISHING.md.
- `codeql.yml`: CodeQL security-extended queries for TypeScript and workflow files.
- `scorecard.yml`: OpenSSF Scorecard.
- `dependency-review.yml`: blocks vulnerable or non-permissively licensed new dependencies.
- `secret-scan.yml`: gitleaks over full history.
- `dependabot.yml`: weekly grouped updates with a 14-day cooldown.
