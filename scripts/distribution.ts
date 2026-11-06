/**
 * Distribution manifests (Claude Code plugin and marketplace, Claude Desktop bundle, MCP Registry),
 * built from the code and package.json so names, versions, tools and settings are defined once.
 * test/generated.test.ts checks the committed files match; `pnpm generate` rewrites them.
 *
 * Formats (checked 2 November 2026):
 * - Claude Code plugins: https://code.claude.com/docs/en/plugins/manifest-reference
 *   and https://code.claude.com/docs/en/plugins/marketplace-reference
 * - MCP Bundles (.mcpb) manifest 0.3: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
 * - MCP Registry server.json: https://github.com/modelcontextprotocol/registry/tree/main/docs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_LAUNCH, SERVER_ID, renderClientsMarkdown } from "../src/cli/clients.js";
import { ENV } from "../src/config.js";
import { TOOLS } from "../src/server.js";
import { REPOSITORY_SLUG, REPOSITORY_URL, SERVER_NAME, SERVER_TITLE } from "../src/version.js";

const ROOT = join(import.meta.dirname, "..");

interface PackageJson {
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly keywords: readonly string[];
  readonly mcpName: string;
  readonly engines: { readonly node: string };
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageJson;

const REPOSITORY = REPOSITORY_URL;
const AUTHOR = { name: "nz-legislation-mcp contributors", url: REPOSITORY };

/** One line; the MCP Registry allows at most 100 characters. */
const SHORT_DESCRIPTION =
  "Search and read New Zealand legislation via the official PCO Legislation API.";

const KEY_DESCRIPTION =
  "Your own API key for api.legislation.govt.nz (request one at https://www.legislation.govt.nz/developer-api/). It is sent only to that API.";

/** Directory of the Claude Code plugin (a subfolder, so it is not confused with the npm package). */
const PLUGIN_DIR = "plugins/nz-legislation-mcp";

/** First sentence of a tool description, for catalogue listings. */
function summary(description: string): string {
  // A sentence ends at ". " before a capital letter (so "e.g. an Act" is not cut).
  const end = /\.\s+(?=[A-Z])/u.exec(description);
  return end === null ? description : description.slice(0, end.index + 1);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function pluginManifest(): string {
  return json({
    $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
    name: SERVER_NAME,
    displayName: SERVER_TITLE,
    version: pkg.version,
    description: SHORT_DESCRIPTION,
    author: AUTHOR,
    homepage: REPOSITORY,
    repository: REPOSITORY,
    license: pkg.license,
    keywords: pkg.keywords,
    userConfig: {
      legislation_nz_api_key: {
        type: "string",
        title: "Legislation API key",
        description: KEY_DESCRIPTION,
        required: true,
        sensitive: true,
      },
    },
  });
}

function pluginMcpConfig(): string {
  return json({
    mcpServers: {
      [SERVER_ID]: {
        // Pinned to this release so a plugin install runs the reviewed version, not whatever
        // is newest on npm. scripts/sync-release-files.mjs updates it in release pull requests.
        command: CLIENT_LAUNCH.command,
        args: ["-y", `${SERVER_NAME}@${pkg.version}`],
        env: { [ENV.apiKey]: "${user_config.legislation_nz_api_key}" },
      },
    },
  });
}

function marketplace(): string {
  return json({
    $schema: "https://json.schemastore.org/claude-code-marketplace.json",
    name: SERVER_NAME,
    owner: { name: String(REPOSITORY_SLUG.split("/")[0]) },
    description: `Claude Code plugin for ${SERVER_NAME}.`,
    plugins: [
      {
        name: SERVER_NAME,
        source: `./${PLUGIN_DIR}`,
        description: SHORT_DESCRIPTION,
        category: "research",
        tags: ["legislation", "new-zealand", "law"],
      },
    ],
  });
}

function bundleManifest(): string {
  return json({
    manifest_version: "0.3",
    name: SERVER_NAME,
    display_name: SERVER_TITLE,
    version: pkg.version,
    description: SHORT_DESCRIPTION,
    long_description: `${pkg.description} Unofficial: not affiliated with the Parliamentary Counsel Office. Check the official version on legislation.govt.nz.`,
    author: AUTHOR,
    repository: { type: "git", url: REPOSITORY },
    homepage: REPOSITORY,
    documentation: `${REPOSITORY}#readme`,
    support: `${REPOSITORY}/issues`,
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: "node",
      entry_point: "dist/cli.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/cli.js", "stdio"],
        env: { [ENV.apiKey]: "${user_config.api_key}" },
      },
    },
    tools: TOOLS.map((tool) => ({ name: tool.name, description: summary(tool.description) })),
    tools_generated: false,
    user_config: {
      api_key: {
        type: "string",
        title: "Legislation API key",
        description: KEY_DESCRIPTION,
        required: true,
        sensitive: true,
      },
    },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
  });
}

function registryServer(): string {
  return json({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: pkg.mcpName,
    title: SERVER_TITLE,
    description: SHORT_DESCRIPTION,
    repository: { url: REPOSITORY, source: "github" },
    version: pkg.version,
    packages: [
      {
        registryType: "npm",
        identifier: SERVER_NAME,
        version: pkg.version,
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: ENV.apiKey,
            description: `${KEY_DESCRIPTION} Optional if you have run "npx ${SERVER_NAME} setup".`,
            isRequired: false,
            isSecret: true,
            format: "string",
          },
        ],
      },
    ],
  });
}

/** Every generated file, by path from the repository root. */
export function generatedFiles(): Readonly<Record<string, string>> {
  return {
    "docs/clients.md": renderClientsMarkdown(),
    ".claude-plugin/marketplace.json": marketplace(),
    [`${PLUGIN_DIR}/.claude-plugin/plugin.json`]: pluginManifest(),
    [`${PLUGIN_DIR}/.mcp.json`]: pluginMcpConfig(),
    "packaging/mcpb/manifest.json": bundleManifest(),
    "server.json": registryServer(),
  };
}

export { SHORT_DESCRIPTION };
