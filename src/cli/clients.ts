/**
 * How to add this server to each AI client: the single source of truth for client setup.
 * docs/clients.md is generated from here (`pnpm generate`) and checked by a test.
 *
 * Formats were taken from each vendor's documentation on 2 November 2026 (links below). The key
 * is not put in client configs: `nz-legislation-mcp setup` stores it in a private file that the
 * server reads itself.
 */

/**
 * The name the server is registered under in client configs.
 *
 * @internal Also used by the generator (scripts/distribution.ts).
 */
export const SERVER_ID = "nz-legislation";

/**
 * How clients launch the server (local, stdio).
 *
 * @internal Also used by the generator (scripts/distribution.ts).
 */
export const CLIENT_LAUNCH = { command: "npx", args: ["-y", "nz-legislation-mcp"] } as const;

interface ClientGuide {
  readonly name: string;
  readonly docs: string;
  /** Markdown paragraphs and code blocks. */
  readonly body: readonly string[];
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const block = (language: string, code: string): string => `\`\`\`${language}\n${code}\n\`\`\``;

/** "Add to Cursor" link: base64 of the server config, URL-encoded. */
function cursorInstallLink(): string {
  const config = Buffer.from(JSON.stringify({ type: "stdio", ...CLIENT_LAUNCH })).toString(
    "base64",
  );
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_ID}&config=${encodeURIComponent(config)}`;
}

/** The server entry VS Code's `--add-mcp` and install link take: JSON including the name. */
function vscodeServerJson(): string {
  return JSON.stringify({ name: SERVER_ID, type: "stdio", ...CLIENT_LAUNCH });
}

/** VS Code install link: the URL-encoded server entry. */
function vscodeInstallLink(): string {
  return `vscode:mcp/install?${encodeURIComponent(vscodeServerJson())}`;
}

const stdioServers = { mcpServers: { [SERVER_ID]: { ...CLIENT_LAUNCH } } };

const CLIENTS: readonly ClientGuide[] = [
  {
    name: "Claude Code",
    docs: "https://code.claude.com/docs/en/mcp",
    body: [
      "Add it for all your projects:",
      block(
        "sh",
        `claude mcp add --transport stdio --scope user ${SERVER_ID} -- ${CLIENT_LAUNCH.command} ${CLIENT_LAUNCH.args.join(" ")}`,
      ),
      "Or install the plugin, which asks for your API key and keeps it in your system's secure credential store (no `setup` needed):",
      block(
        "sh",
        "claude plugin marketplace add thatskiff33/nz-legislation-mcp\nclaude plugin install nz-legislation-mcp@nz-legislation-mcp --scope user",
      ),
    ],
  },
  {
    name: "Claude Desktop",
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    body: [
      "Easiest: download `nz-legislation-mcp.mcpb` from the latest GitHub release and open it. Claude Desktop asks for your API key and stores it securely; you do not need `setup`.",
      "Or edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\\Claude\\`) and restart Claude Desktop:",
      block("json", json(stdioServers)),
    ],
  },
  {
    name: "OpenAI Codex CLI",
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    body: [
      block(
        "sh",
        `codex mcp add ${SERVER_ID} -- ${CLIENT_LAUNCH.command} ${CLIENT_LAUNCH.args.join(" ")}`,
      ),
      "Or add to `~/.codex/config.toml`:",
      block(
        "toml",
        `[mcp_servers.${SERVER_ID}]\ncommand = "${CLIENT_LAUNCH.command}"\nargs = [${CLIENT_LAUNCH.args.map((a) => `"${a}"`).join(", ")}]`,
      ),
    ],
  },
  {
    name: "Cursor",
    docs: "https://cursor.com/docs/mcp",
    body: [
      `One click: [Add to Cursor](${cursorInstallLink()}).`,
      "Or add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):",
      block("json", json({ mcpServers: { [SERVER_ID]: { type: "stdio", ...CLIENT_LAUNCH } } })),
    ],
  },
  {
    name: "VS Code (GitHub Copilot)",
    docs: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
    body: [
      `One click: [Install in VS Code](${vscodeInstallLink()}).`,
      "Or from a terminal on macOS or Linux:",
      block("sh", `code --add-mcp '${vscodeServerJson()}'`),
      "In Windows PowerShell 5.1, escape the inner quotes (single-quoted JSON loses its quotes when passed to `code`). In PowerShell 7 or later, use the one-click link or the file below if this form does not work:",
      block("powershell", `code --add-mcp '${vscodeServerJson().replaceAll('"', '\\"')}'`),
      "In Command Prompt, use the one-click link or the file below.",
      "Or add to `.vscode/mcp.json`:",
      block("json", json({ servers: { [SERVER_ID]: { type: "stdio", ...CLIENT_LAUNCH } } })),
    ],
  },
  {
    name: "Gemini CLI",
    docs: "https://geminicli.com/docs/tools/mcp-server/",
    body: ["Add to `~/.gemini/settings.json`:", block("json", json(stdioServers))],
  },
];

/** Printed after `setup` succeeds. */
export const CLIENT_SETUP_HINT = [
  "Next, add the server to your AI client, for example:",
  "",
  `  Claude Code:  claude mcp add --transport stdio --scope user ${SERVER_ID} -- ${CLIENT_LAUNCH.command} ${CLIENT_LAUNCH.args.join(" ")}`,
  `  Codex CLI:    codex mcp add ${SERVER_ID} -- ${CLIENT_LAUNCH.command} ${CLIENT_LAUNCH.args.join(" ")}`,
  "",
  "Other clients (Claude Desktop, Cursor, VS Code, Gemini CLI): see docs/clients.md",
  "https://github.com/thatskiff33/nz-legislation-mcp/blob/main/docs/clients.md",
  "",
].join("\n");

/**
 * The full docs/clients.md.
 *
 * @internal Used by the generator (scripts/distribution.ts).
 */
export function renderClientsMarkdown(): string {
  const sections = CLIENTS.map(
    (client) =>
      `## ${client.name}\n\n${client.body.join("\n\n")}\n\nVendor documentation: ${client.docs}`,
  );
  return `<!-- Generated from src/cli/clients.ts by "pnpm generate". Do not edit by hand. -->

# Adding the server to your AI client

These steps run the server on your own computer (recommended). For ChatGPT, Claude on the web and the xAI API, which need a remote endpoint, see [self-hosting.md](self-hosting.md).

## First, save your API key

Run this once. It asks for your key (input hidden), checks it with the Legislation API, and stores it in a file only you can read, so client settings never contain the key:

${block("sh", "npx -y nz-legislation-mcp setup")}

If your terminal can't hide typing (for example Git Bash or mintty on Windows), setup stops without reading the key. Run it in PowerShell or Windows Terminal instead, or pipe the key in from a file with \`npx -y nz-legislation-mcp setup --key-stdin < keyfile\` (avoid \`echo\`, which leaves the key in your shell history).

Check everything is working at any time with \`npx -y nz-legislation-mcp doctor\`. It exits with code 1 if a required check fails (Node.js, the key, the Legislation API). A warning about legislation.govt.nz, which only the text tools need, is reported but does not change the exit code.

Node.js 22 or later is required.

${sections.join("\n\n")}

## Other clients

Any MCP client that can start a local (stdio) server can use it: the command is \`${CLIENT_LAUNCH.command}\` with arguments \`${CLIENT_LAUNCH.args.join(" ")}\`. Check your client's documentation for where to add it.
`;
}
