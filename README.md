# nz-legislation-mcp

Unofficial Model Context Protocol (MCP) server for the New Zealand Legislation API
(`api.legislation.govt.nz`). Search and read NZ Acts, Bills and secondary legislation
from Claude, ChatGPT/Codex, Cursor, Grok and other MCP clients, using your own API key.

**Status:** under construction. See the epic issue for progress.

Not an official Parliamentary Counsel Office product. Always check the official
version on [legislation.govt.nz](https://www.legislation.govt.nz) before relying on it.

## Remote endpoint (ChatGPT, Claude on the web, Grok)

Clients that cannot start a local program need a remote HTTPS endpoint. The server has a hardened HTTP mode that only admits you, through your own OAuth provider. See [docs/self-hosting.md](docs/self-hosting.md).

Licensed under Apache-2.0.
