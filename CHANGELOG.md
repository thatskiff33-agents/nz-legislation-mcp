# Changelog

## [1.0.2](https://github.com/thatskiff33/nz-legislation-mcp/compare/v1.0.1...v1.0.2) (2026-11-07)


### Bug Fixes

* **cli:** show a person-facing message when the key is rejected (401) ([#91](https://github.com/thatskiff33/nz-legislation-mcp/issues/91)) ([c0caae3](https://github.com/thatskiff33/nz-legislation-mcp/commit/c0caae3d002e88f7f1173ed22664f117880b1569))

## [1.0.1](https://github.com/thatskiff33/nz-legislation-mcp/compare/v1.0.0...v1.0.1) (2026-11-06)


### Bug Fixes

* **release:** publish the npm tarball by local path; dry-run it in CI ([#78](https://github.com/thatskiff33/nz-legislation-mcp/issues/78)) ([e71ab6c](https://github.com/thatskiff33/nz-legislation-mcp/commit/e71ab6c682116628d733b07b82d9956ecd29e620)), closes [#77](https://github.com/thatskiff33/nz-legislation-mcp/issues/77)

## 1.0.0 (2026-11-06)

Not published. The tagged release run was cancelled after its npm publish step failed ([#77](https://github.com/thatskiff33/nz-legislation-mcp/issues/77)), so 1.0.0 was not published to npm, GHCR or GitHub releases. 1.0.1 is the first published release and includes everything below.


### Features

* domain single source of truth, identifiers and config ([#17](https://github.com/thatskiff33/nz-legislation-mcp/issues/17)) ([4ce445c](https://github.com/thatskiff33/nz-legislation-mcp/commit/4ce445c71c6b762bfc94822bdeb4123de1c65a1d))
* hardened Legislation API client ([#18](https://github.com/thatskiff33/nz-legislation-mcp/issues/18)) ([5362169](https://github.com/thatskiff33/nz-legislation-mcp/commit/5362169ebaf412fc278697afef67a47997065f05))
* hardened Streamable HTTP mode (OAuth resource server) ([#22](https://github.com/thatskiff33/nz-legislation-mcp/issues/22)) ([c927ce8](https://github.com/thatskiff33/nz-legislation-mcp/commit/c927ce820ef4965b66d1ac77c3dc8c8dc417cb0c))
* MCP resource templates and prompts ([#20](https://github.com/thatskiff33/nz-legislation-mcp/issues/20)) ([#25](https://github.com/thatskiff33/nz-legislation-mcp/issues/25)) ([dec9988](https://github.com/thatskiff33/nz-legislation-mcp/commit/dec9988c2ae7ec1c54c39569b98c46f3139c95bb))
* MCP server with search, get, list-versions and quota tools (stdio) ([#19](https://github.com/thatskiff33/nz-legislation-mcp/issues/19)) ([67768e2](https://github.com/thatskiff33/nz-legislation-mcp/commit/67768e24ae351781d01e556bd1934445a9ef8c78))
* read legislation text (table of contents, provision text, compare versions) ([#21](https://github.com/thatskiff33/nz-legislation-mcp/issues/21)) ([4b56430](https://github.com/thatskiff33/nz-legislation-mcp/commit/4b564301ca3ff889c8f717d11bee46c59f0ade51))
* self-hosting kit (container, Compose with Caddy, guide) ([#23](https://github.com/thatskiff33/nz-legislation-mcp/issues/23)) ([9f51e66](https://github.com/thatskiff33/nz-legislation-mcp/commit/9f51e666af07dd627412092eb4e0c399ebb46073))
* setup, client docs, plugin, bundle, registry and release automation ([#10](https://github.com/thatskiff33/nz-legislation-mcp/issues/10)) ([#24](https://github.com/thatskiff33/nz-legislation-mcp/issues/24)) ([c674c76](https://github.com/thatskiff33/nz-legislation-mcp/commit/c674c766c6824092711fe209949cb5c4160c1d4e))
* **tools:** add a subpart argument so Part N and Subpart N are distinct ([#61](https://github.com/thatskiff33/nz-legislation-mcp/issues/61)) ([7523864](https://github.com/thatskiff33/nz-legislation-mcp/commit/7523864c7b7207abe8635c9b0f5ce63a28466c7e))


### Bug Fixes

* **cli:** never read the key from an echoing terminal; honest doctor ([#56](https://github.com/thatskiff33/nz-legislation-mcp/issues/56)) ([94b3ab6](https://github.com/thatskiff33/nz-legislation-mcp/commit/94b3ab66f0027a2c956b6c2a4528a82179e8bfc2))
* **errors:** accurate messages for XML downloads and key problems ([#59](https://github.com/thatskiff33/nz-legislation-mcp/issues/59)) ([9a9735d](https://github.com/thatskiff33/nz-legislation-mcp/commit/9a9735d2d6328bee21f09ca919d82906b22493dc))
* **http:** refuse requests at the header limit (431) ([#67](https://github.com/thatskiff33/nz-legislation-mcp/issues/67)) ([ac5b753](https://github.com/thatskiff33/nz-legislation-mcp/commit/ac5b753552eb1b57e7f2841dc92559ea2a222acd))
* **release:** isolate the npm tarball, ignore CHANGELOG, publish releases as drafts ([#52](https://github.com/thatskiff33/nz-legislation-mcp/issues/52)) ([ad13c82](https://github.com/thatskiff33/nz-legislation-mcp/commit/ad13c829af1cc63109f7e4839dbdfa0d41f1dccb)), closes [#36](https://github.com/thatskiff33/nz-legislation-mcp/issues/36)
* **security:** fuller key redaction, strict true/false settings, privacy-safe refusal logs ([#58](https://github.com/thatskiff33/nz-legislation-mcp/issues/58)) ([df23116](https://github.com/thatskiff33/nz-legislation-mcp/commit/df23116757e0c407775c336a2659f2162ed530b7))
* **text:** keep closing words, signature blocks and characters intact ([#51](https://github.com/thatskiff33/nz-legislation-mcp/issues/51)) ([a21ece4](https://github.com/thatskiff33/nz-legislation-mcp/commit/a21ece41b47dc65f53f975714fa5432c3315db3b)), closes [#39](https://github.com/thatskiff33/nz-legislation-mcp/issues/39)
* **tools:** describe diff counts as whole-comparison; keep the page size in continue_with ([#76](https://github.com/thatskiff33/nz-legislation-mcp/issues/76)) ([7d829b5](https://github.com/thatskiff33/nz-legislation-mcp/commit/7d829b56db8da450fa9a7822cf3611ab6648043d))
* **tools:** refuse reversed comparisons, pin paging to one version, explain truncation ([#57](https://github.com/thatskiff33/nz-legislation-mcp/issues/57)) ([b71d73d](https://github.com/thatskiff33/nz-legislation-mcp/commit/b71d73d596b4eeee73c6f2caa312ff9567dff679))
