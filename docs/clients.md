<!-- Generated from src/cli/clients.ts by "pnpm docs:clients". Do not edit by hand. -->

# Adding the server to your AI client

These steps run the server on your own computer (recommended). For ChatGPT, Claude on the web and the xAI API, which need a remote endpoint, see [self-hosting.md](self-hosting.md).

## First, save your API key

Run this once. It asks for your key (input hidden), checks it with the Legislation API, and stores it in a file only you can read, so client settings never contain the key:

```sh
npx -y nz-legislation-mcp setup
```

If your terminal can't hide typing (for example Git Bash or mintty on Windows), setup stops without reading the key. Run it in PowerShell or Windows Terminal instead, or pipe the key in from a file with `npx -y nz-legislation-mcp setup --key-stdin < keyfile` (avoid `echo`, which leaves the key in your shell history).

Check everything is working at any time with `npx -y nz-legislation-mcp doctor`. It exits with code 1 if a required check fails (Node.js, the key, the Legislation API). A warning about legislation.govt.nz, which only the text tools need, is reported but does not change the exit code.

Node.js 22 or later is required.

## Claude Code

Add it for all your projects:

```sh
claude mcp add --transport stdio --scope user nz-legislation -- npx -y nz-legislation-mcp
```

Or install the plugin, which asks for your API key and keeps it in your system's secure credential store (no `setup` needed):

```sh
claude plugin marketplace add thatskiff33/nz-legislation-mcp
claude plugin install nz-legislation-mcp@nz-legislation-mcp --scope user
```

Vendor documentation: https://code.claude.com/docs/en/mcp

## Claude Desktop

Easiest: download `nz-legislation-mcp.mcpb` from the latest GitHub release and open it. Claude Desktop asks for your API key and stores it securely; you do not need `setup`.

Or edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "nz-legislation": {
      "command": "npx",
      "args": ["-y", "nz-legislation-mcp"]
    }
  }
}
```

Vendor documentation: https://modelcontextprotocol.io/docs/develop/connect-local-servers

## OpenAI Codex CLI

```sh
codex mcp add nz-legislation -- npx -y nz-legislation-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.nz-legislation]
command = "npx"
args = ["-y", "nz-legislation-mcp"]
```

Vendor documentation: https://learn.chatgpt.com/docs/extend/mcp?surface=cli

## Cursor

One click: [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=nz-legislation&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm56LWxlZ2lzbGF0aW9uLW1jcCJdfQ%3D%3D).

Or add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "nz-legislation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nz-legislation-mcp"]
    }
  }
}
```

Vendor documentation: https://cursor.com/docs/mcp

## VS Code (GitHub Copilot)

One click: [Install in VS Code](vscode:mcp/install?%7B%22name%22%3A%22nz-legislation%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22nz-legislation-mcp%22%5D%7D).

Or from a terminal:

```sh
code --add-mcp '{"name":"nz-legislation","type":"stdio","command":"npx","args":["-y","nz-legislation-mcp"]}'
```

Or add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "nz-legislation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "nz-legislation-mcp"]
    }
  }
}
```

Vendor documentation: https://code.visualstudio.com/docs/agents/reference/mcp-configuration

## Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "nz-legislation": {
      "command": "npx",
      "args": ["-y", "nz-legislation-mcp"]
    }
  }
}
```

Vendor documentation: https://geminicli.com/docs/tools/mcp-server/

## Other clients

Any MCP client that can start a local (stdio) server can use it: the command is `npx` with arguments `-y nz-legislation-mcp`. Check your client's documentation for where to add it.
