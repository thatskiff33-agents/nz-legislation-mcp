/**
 * Messages for a person at a terminal (`setup`, `doctor`).
 *
 * ApiError messages are written for the AI model calling a tool (src/api/errors.ts). Most read
 * fine at a terminal too, but the 401 guidance talks about "the user" and the AI client, so the
 * commands replace it with advice for the person running them (#88).
 */
import type { ApiError } from "../api/errors.js";

/** Where the command is running, which decides the advice for a rejected key. */
export type TerminalCommand = "setup" | "doctor";

const REJECTED = "The Legislation API rejected the API key (401).";

const REJECTED_ADVICE: Readonly<Record<TerminalCommand, string>> = {
  // The person has just pasted the key, so the likely causes are a partial copy or an old key.
  setup: `${REJECTED} Check that you copied the whole key PCO sent you and that it is your current key.`,
  // The "API key" line above names where the key came from.
  doctor: `${REJECTED} Check that it is your current key from PCO; the API key line above shows where it came from. To replace the key saved by setup, run "npx -y nz-legislation-mcp setup --force".`,
};

/** The message to show a person at a terminal for an API error. */
export function terminalMessage(error: ApiError, command: TerminalCommand): string {
  return error.kind === "unauthorised" ? REJECTED_ADVICE[command] : error.message;
}
