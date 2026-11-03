# Agent rules for nz-legislation-mcp

These rules apply to any AI coding agent (Claude Code, Codex, Cursor, others) working in this repository.

## Project

Unofficial MCP server for the New Zealand Legislation API (PCO, `api.legislation.govt.nz`, v0). TypeScript on the official MCP TypeScript SDK v2. Read-only tools. Each user supplies their own API key.

## Working agreement

1. Work is organised as epic (#12), then waves, then issues. One pull request per issue.
2. Claim an issue by adding the `in-progress` label, then open a draft PR early that says `Closes #N`.
3. Decisions: when a real choice exists, add a Decisions section to the issue with checkbox options and a Recommended default, labelled `needs-decision`. Ask the owner in-session, record the answer on the issue, remove the label.
4. Before marking a PR ready: independent review (security, correctness, and any lens fitting the risk), fix findings, verify fixes, CI green. Post a plain-English ready comment: what was built, reviews and findings, fixes, carry-forwards.
5. Carry-forwards only for things needing an owner decision or a fresh plan, filed as a linked `needs-decision` issue.
6. Merging (owner decision in an agent session, 4 November 2026: "I approve you to merge. I don't comment on github. You get it sorted."): the agent squash-merges a PR, and deletes its branch, once all of these hold:
   - it is out of draft and CI is green on the final commit;
   - an independent review has signed off on the final changes, with every finding fixed or answered;
   - no owner decision on it is open.

   The agent records the merge decision on the PR. Releases and publishing (npm, MCP Registry, container images), repository settings, and anything legal stay with the owner.

## Hard rules

- Never commit, log, print or return an API key. Never put a key in a URL. The key is sent only as the `X-Api-Key` header to allowlisted PCO hosts.
- Keep `pnpm check` green. Its components are listed in CONTRIBUTING.md and include a 100% line and branch coverage gate.
- Enums, identifier formats and response shapes are defined once in `src/domain/` (from issue #4). Do not duplicate them.
- Every external input is parsed with a schema at the boundary.
- stdout is reserved for the MCP stdio protocol. Log to stderr only.
- Pin GitHub Actions by full commit SHA. New runtime dependencies need a justification in the PR.
- Response caching is disabled by default until the PCO confirms in writing that it is allowed (issue #3).
- Remote (non-localhost) HTTP mode requires OAuth 2.1 (issue #8).

## Style

NZ English in docs. Conventional Commits. Prefer small pure functions and explicit types at module boundaries.
