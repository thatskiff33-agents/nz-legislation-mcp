#!/usr/bin/env node
// Command-line entry (the `nz-legislation-mcp` binary). All logic lives in main.ts.
import { runCli } from "./main.js";

const code = await runCli(process.argv.slice(2));
if (code !== undefined) process.exitCode = code;
