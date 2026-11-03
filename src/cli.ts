#!/usr/bin/env node
// Command-line entry (the `nz-legislation-mcp` binary). All logic lives in main.ts.
import { main } from "./main.js";

const code = main();
if (code !== undefined) process.exitCode = code;
