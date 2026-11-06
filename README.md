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

For clients that support them, there are also:

- Resources you can attach as context: `legislation://version/{version_id}/contents`,
  `.../section/{section}` and `.../schedule/{schedule}` (for example
  `legislation://version/act_public_1976_33_en_2014-01-01/section/6A`).
- Two prompts: `find_provision` (find and quote the provision on a topic) and `what_changed`
  (how legislation, or one provision, has changed since a date).

## Quick start

You need Node.js 22 or later and your own Legislation API key. Request one by email to
contact@pco.govt.nz (see [legislation.govt.nz/developer-api](https://www.legislation.govt.nz/developer-api/)).
The key is personal: PCO's terms do not allow it to be shared.

1. Save your key once. Input is hidden, the key is checked with the API, and it is stored
   in a file only you can read:

   ```sh
   npx -y nz-legislation-mcp setup
   ```

   If your terminal can't hide typing (for example Git Bash on Windows), setup stops
   without reading the key: use PowerShell or Windows Terminal, or pipe it from a file with `--key-stdin < keyfile`.

2. Add the server to your AI client. For example, Claude Code:

   ```sh
   claude mcp add --transport stdio --scope user nz-legislation -- npx -y nz-legislation-mcp
   ```

   or Codex CLI:

   ```sh
   codex mcp add nz-legislation -- npx -y nz-legislation-mcp
   ```

3. Check it works: `npx -y nz-legislation-mcp doctor`. It exits with code 1 if a required check
   fails; a warning (for example about legislation.govt.nz) does not change the exit code.

Steps for Claude Desktop (one-click bundle), Cursor, VS Code, Gemini CLI and others are in
[docs/clients.md](docs/clients.md).

### Claude Code plugin

The plugin asks for your key and keeps it in your system's secure credential store, so you
can skip `setup`:

```sh
/plugin install nz-legislation-mcp --marketplace thatskiff33/nz-legislation-mcp
```

On Claude Code versions before 2.1.275, run
`/plugin marketplace add thatskiff33/nz-legislation-mcp` and then
`/plugin install nz-legislation-mcp@nz-legislation-mcp`.

## Remote endpoint (ChatGPT, Claude on the web, Grok)

Clients that cannot start a local program need a remote HTTPS endpoint. The server has a hardened HTTP mode that only admits you, through your own OAuth provider. See [docs/self-hosting.md](docs/self-hosting.md).

## Security and privacy

- Your key is only ever sent, as a request header, to `api.legislation.govt.nz`. It is never
  logged, put in a URL or returned to the AI client.
- The tools are read-only and only fetch from `api.legislation.govt.nz` and
  `www.legislation.govt.nz` (in remote mode the server also fetches your OAuth provider's
  discovery metadata and public signing keys).
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md).
Maintainers: release steps are in [PUBLISHING.md](PUBLISHING.md).

Licensed under Apache-2.0.
