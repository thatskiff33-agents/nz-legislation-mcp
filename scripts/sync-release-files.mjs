// Updates version strings that release-please cannot bump itself (it replaces whole JSON values,
// and the plugin pins "nz-legislation-mcp@<version>"). Dependency-free so the release workflow
// can run it without installing anything. "--check" exits 1 instead of writing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = join(import.meta.dirname, "..");
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const file = join(root, "plugins", name, ".mcp.json");

const before = readFileSync(file, "utf8");
const after = before.replace(new RegExp(`"${name}@[^"]*"`, "gu"), `"${name}@${version}"`);

if (process.argv.includes("--check")) {
  if (after !== before) {
    process.stderr.write(`${file} is not pinned to ${name}@${version}\n`);
    process.exitCode = 1;
  }
} else if (after !== before) {
  writeFileSync(file, after);
}
