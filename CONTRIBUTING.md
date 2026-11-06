# Contributing

Thanks for helping. This project aims for a high bar on security and code quality, so please read this first.

## Ground rules

- Open or pick an issue before starting work. One pull request per issue.
- Keep pull requests focused. Open them as drafts early.
- Never commit API keys, `.env` files or real user data. Test fixtures must be sanitised.
- Every change must pass `pnpm check`: typecheck, lint, format check, dead-code check (knip), tests with 100% line and branch coverage (including drift checks for generated files and docs), build.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and PR titles (for example `feat: add list_versions tool`).
- Report security issues privately. See [SECURITY.md](SECURITY.md).

## Local setup

See [docs/development.md](docs/development.md) for prerequisites and commands.

## Design principles

- Single source of truth: API enums, identifiers and shapes live once in `src/domain/` and everything else derives from them.
- Parse, don't validate: every external input (API responses, XML, tool arguments, config) is schema-parsed at the boundary.
- Secure by default: read-only tools, localhost binding, outbound host allowlist, no secrets in logs or output.
- Small dependency footprint: justify every new runtime dependency in the PR.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
