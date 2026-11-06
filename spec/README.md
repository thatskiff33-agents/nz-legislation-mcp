# API specification snapshot

`legislation-api-v0.openapi.json` is the OpenAPI 3.0.1 specification for the NZ Legislation API (v0), extracted on 2 November 2026 from the specification embedded in <https://api.legislation.govt.nz/docs/> (the page's "Download" link is generated in the browser and has no fixed URL). Keys are sorted (`jq -S`) for stable diffs.

It is used to:

- check that `src/domain/vocabulary.ts` matches every enum in the spec (unit test), and
- detect upstream changes: when the snapshot is refreshed by hand, its diff shows what PCO changed. There is no scheduled contract job yet.

Do not edit it by hand. Refresh it only as a deliberate change, with a note in `docs/api-notes.md`.
