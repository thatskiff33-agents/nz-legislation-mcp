# Development

## Prerequisites

- Node.js 22 or later (`.nvmrc` pins the minimum).
- pnpm, via Corepack: `corepack enable` (the exact version is pinned in `package.json`).

## Commands

| Command           | What it does                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies. Refuses packages younger than 14 days and blocks install scripts.                     |
| `pnpm check`      | Everything CI runs: typecheck, lint, format check, dead-code check (knip), tests with 100% coverage, build. |
| `pnpm test`       | Tests with coverage.                                                                                        |
| `pnpm test:watch` | Tests in watch mode.                                                                                        |
| `pnpm format`     | Format all files with Prettier.                                                                             |
| `pnpm build`      | Compile `src/` to `dist/`.                                                                                  |

## Toolchain notes

- TypeScript is pinned to 6.0.x because `typescript-eslint` type-aware rules do not yet support TypeScript 7.
- `@types/node` tracks the minimum supported Node line (22).
- Supply-chain settings live in `pnpm-workspace.yaml` (`minimumReleaseAge`, `onlyBuiltDependencies`, `strictDepBuilds`).

## Continuous integration

All workflows pin actions to full commit SHAs and default to read-only permissions.

- `ci.yml`: `pnpm check` on Node 22 and 24, plus `pnpm audit`.
- `codeql.yml`: CodeQL security-extended queries for TypeScript and workflow files.
- `scorecard.yml`: OpenSSF Scorecard.
- `dependency-review.yml`: blocks vulnerable or non-permissively licensed new dependencies.
- `secret-scan.yml`: gitleaks over full history.
- `dependabot.yml`: weekly grouped updates with a 14-day cooldown.
