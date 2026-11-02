# nz-legislation-mcp

Unofficial Model Context Protocol (MCP) server for the New Zealand Legislation API
(`api.legislation.govt.nz`). Search and read NZ Acts, Bills and secondary legislation
from Claude, ChatGPT/Codex, Cursor, Grok and other MCP clients, using your own API key.

**Status:** pre-release. Not yet published to npm. See the epic issue for progress.

Not an official Parliamentary Counsel Office product. Always check the official
version on [legislation.govt.nz](https://www.legislation.govt.nz) before relying on it.

## What it can do

| Tool                    | What it does                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `search_legislation`    | Find Acts, Bills, secondary legislation and amendment papers by title, full text or filters. |
| `get_legislation`       | One work or version, including the version in force on a past date (`as_at`).                |
| `list_versions`         | The point-in-time version history of a work.                                                 |
| `get_table_of_contents` | Parts, subparts, sections and schedules.                                                     |
| `get_provision_text`    | The text of a section, schedule clause or schedule, from the official XML.                   |
| `compare_versions`      | What changed in a provision between two versions or dates.                                   |
| `get_api_quota`         | How much of your daily API quota is left (makes no API call).                                |

## Quick start

You need Node.js 22 or later and your own Legislation API key from the Parliamentary
Counsel Office (see the [API documentation](https://api.legislation.govt.nz/docs/)). The
key is personal: PCO's terms do not allow it to be shared.

1. Save your key once. Input is hidden, the key is checked with the API, and it is stored
   in a file only you can read:

   ```sh
   npx -y nz-legislation-mcp setup
   ```

2. Add the server to your AI client. For example, Claude Code:

   ```sh
   claude mcp add --transport stdio --scope user nz-legislation -- npx -y nz-legislation-mcp
   ```

   or Codex CLI:

   ```sh
   codex mcp add nz-legislation -- npx -y nz-legislation-mcp
   ```

3. Check it works: `npx -y nz-legislation-mcp doctor`.

Steps for Claude Desktop (one-click bundle), Cursor, VS Code, Gemini CLI and others are in
[docs/clients.md](docs/clients.md).

### Claude Code plugin

The plugin asks for your key and keeps it in your system's secure credential store, so you
can skip `setup`:

```sh
/plugin install nz-legislation-mcp --marketplace thatskiff33-agents/nz-legislation-mcp
```

On Claude Code versions before 2.1.275, run
`/plugin marketplace add thatskiff33-agents/nz-legislation-mcp` and then
`/plugin install nz-legislation-mcp@nz-legislation-mcp`.

## Remote endpoint (ChatGPT, Claude on the web, Grok)

Clients that cannot start a local program need a remote HTTPS endpoint. The server has a hardened HTTP mode that only admits you, through your own OAuth provider. See [docs/self-hosting.md](docs/self-hosting.md).

## Security and privacy

- Your key is only ever sent, as a request header, to `api.legislation.govt.nz`. It is never
  logged, put in a URL or returned to the AI client.
- The tools are read-only and only fetch from `api.legislation.govt.nz` and
  `www.legislation.govt.nz` (in remote mode the server also fetches your OAuth provider's
  public signing keys).
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md).
Maintainers: release steps are in [PUBLISHING.md](PUBLISHING.md).

Licensed under Apache-2.0.
