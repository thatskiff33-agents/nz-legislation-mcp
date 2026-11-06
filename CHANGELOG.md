# Changelog

## 1.0.0 (2026-11-06)


### Features

* domain single source of truth, identifiers and config ([#17](https://github.com/thatskiff33/nz-legislation-mcp/issues/17)) ([b2ef1ce](https://github.com/thatskiff33/nz-legislation-mcp/commit/b2ef1ce121293c8bc0576f4b9c249b81cd54d250))
* hardened Legislation API client ([#18](https://github.com/thatskiff33/nz-legislation-mcp/issues/18)) ([5051470](https://github.com/thatskiff33/nz-legislation-mcp/commit/5051470878c0979dd7b6df7c3ba2fc684494d850))
* hardened Streamable HTTP mode (OAuth resource server) ([#22](https://github.com/thatskiff33/nz-legislation-mcp/issues/22)) ([25b6386](https://github.com/thatskiff33/nz-legislation-mcp/commit/25b6386010ab7ff7b1faecaf51e0d8b9b4455b1e))
* MCP resource templates and prompts ([#20](https://github.com/thatskiff33/nz-legislation-mcp/issues/20)) ([#25](https://github.com/thatskiff33/nz-legislation-mcp/issues/25)) ([549d8fe](https://github.com/thatskiff33/nz-legislation-mcp/commit/549d8fe2e20a2ff57fb92b17c19c6ff28ce538a5))
* MCP server with search, get, list-versions and quota tools (stdio) ([#19](https://github.com/thatskiff33/nz-legislation-mcp/issues/19)) ([4e28ba0](https://github.com/thatskiff33/nz-legislation-mcp/commit/4e28ba0edb09dd80bf4647320926fa00c46704fb))
* read legislation text (table of contents, provision text, compare versions) ([#21](https://github.com/thatskiff33/nz-legislation-mcp/issues/21)) ([f5d4a3a](https://github.com/thatskiff33/nz-legislation-mcp/commit/f5d4a3a001124255c3d80f527c6031b40de54e6a))
* self-hosting kit (container, Compose with Caddy, guide) ([#23](https://github.com/thatskiff33/nz-legislation-mcp/issues/23)) ([053f622](https://github.com/thatskiff33/nz-legislation-mcp/commit/053f622a2f65b9e66e90227ce7e80c2edb5cb1b6))
* setup, client docs, plugin, bundle, registry and release automation ([#10](https://github.com/thatskiff33/nz-legislation-mcp/issues/10)) ([#24](https://github.com/thatskiff33/nz-legislation-mcp/issues/24)) ([92c9007](https://github.com/thatskiff33/nz-legislation-mcp/commit/92c900753da56c6cde415d7f270cc75180a1a48c))
* **tools:** add a subpart argument so Part N and Subpart N are distinct ([#61](https://github.com/thatskiff33/nz-legislation-mcp/issues/61)) ([2e2630d](https://github.com/thatskiff33/nz-legislation-mcp/commit/2e2630d90031e7608ace4acc421f46adbe4bc24c))


### Bug Fixes

* **cli:** never read the key from an echoing terminal; honest doctor ([#56](https://github.com/thatskiff33/nz-legislation-mcp/issues/56)) ([c701327](https://github.com/thatskiff33/nz-legislation-mcp/commit/c7013272b323f81c30323a168d2acb1cf436e99d))
* **errors:** accurate messages for XML downloads and key problems ([#59](https://github.com/thatskiff33/nz-legislation-mcp/issues/59)) ([8959f52](https://github.com/thatskiff33/nz-legislation-mcp/commit/8959f5285ed5ef860698ab2c8ffa4893999d2ed1))
* **http:** refuse requests at the header limit (431) ([#67](https://github.com/thatskiff33/nz-legislation-mcp/issues/67)) ([ff72344](https://github.com/thatskiff33/nz-legislation-mcp/commit/ff723443ea759624c7356352e209e489f0fc8947))
* **release:** isolate the npm tarball, ignore CHANGELOG, publish releases as drafts ([#52](https://github.com/thatskiff33/nz-legislation-mcp/issues/52)) ([3c88052](https://github.com/thatskiff33/nz-legislation-mcp/commit/3c880528123071024d701fd08a2bc3618ebb1ae7)), closes [#36](https://github.com/thatskiff33/nz-legislation-mcp/issues/36)
* **security:** fuller key redaction, strict true/false settings, privacy-safe refusal logs ([#58](https://github.com/thatskiff33/nz-legislation-mcp/issues/58)) ([d2b113f](https://github.com/thatskiff33/nz-legislation-mcp/commit/d2b113fef5a8ee243ad008b553d7dfcde4988496))
* **text:** keep closing words, signature blocks and characters intact ([#51](https://github.com/thatskiff33/nz-legislation-mcp/issues/51)) ([b5bd021](https://github.com/thatskiff33/nz-legislation-mcp/commit/b5bd021a8cb25be6edc75a8c749395930447ed2b)), closes [#39](https://github.com/thatskiff33/nz-legislation-mcp/issues/39)
* **tools:** refuse reversed comparisons, pin paging to one version, explain truncation ([#57](https://github.com/thatskiff33/nz-legislation-mcp/issues/57)) ([07030e6](https://github.com/thatskiff33/nz-legislation-mcp/commit/07030e69bd93b541dc50294779115e409f144fe9))
