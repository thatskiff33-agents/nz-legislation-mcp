/**
 * MCP prompts: ready-made requests a user can pick in clients that show prompts (for example as
 * slash commands). Each one asks the model to use this server's tools in the usual order and to
 * cite what it read. Arguments are typed by the user, so they are length-limited, stripped of
 * control characters and shown in quotation marks as the user's words.
 */
import type { GetPromptResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { freeText } from "./domain/schemas.js";

/** Longest argument accepted (a topic, an Act's name or a provision label). */
const MAX_ARGUMENT_LENGTH = 200;

const text = (max = MAX_ARGUMENT_LENGTH): z.ZodString => freeText(max);
const isoDate = z.iso.date({ error: "Use a date in the form YYYY-MM-DD." });

const CITATION_RULES = [
  "Quote the relevant words exactly, and cite the title, the section or clause, the version date and the dated permalink from the tool results.",
  "If the result depends on how the text is read, say so. This is not legal advice: remind me to check the official version on legislation.govt.nz.",
];

/** Puts the user's words in quotation marks, without letting them close the quote. */
const quoted = (value: string): string => `"${value.replaceAll('"', "'")}"`;

function message(lines: readonly string[]): GetPromptResult {
  return {
    messages: [{ role: "user", content: { type: "text", text: lines.join("\n") } }],
  };
}

const FindArgs = z.strictObject({
  topic: text().describe("What you are looking for, e.g. 'when a company must file a return'."),
  legislation: text()
    .optional()
    .describe("Act or regulations to search within, if known, e.g. 'Income Tax Act 2007'."),
  as_at: isoDate.optional().describe("Find the law as at this date (YYYY-MM-DD); default today."),
});

const ChangedArgs = z.strictObject({
  legislation: text().describe("The Act or regulations, e.g. 'Goods and Services Tax Act 1985'."),
  since: isoDate.describe("Earlier date to compare from (YYYY-MM-DD)."),
  provision: text(40)
    .optional()
    .describe("A section, clause or schedule to compare, e.g. 'section 8'. Default: whole work."),
});

function findProvisionPrompt(args: z.output<typeof FindArgs>): GetPromptResult {
  const date = args.as_at ?? "today";
  return message([
    `Find the provision of New Zealand legislation that deals with this topic: ${quoted(args.topic)}.`,
    ...(args.legislation === undefined
      ? []
      : [`Look in this legislation: ${quoted(args.legislation)}.`]),
    `Use the law as at ${date}.`,
    "",
    "Use the nz-legislation tools:",
    `1. search_legislation to find the work_id${args.legislation === undefined ? " (search content if a title search finds nothing)" : ""}.`,
    `2. get_table_of_contents with that work_id${args.as_at === undefined ? "" : ` and as_at ${args.as_at}`} to find likely sections.`,
    `3. get_provision_text with the same work_id${args.as_at === undefined ? "" : ` and as_at ${args.as_at}`} (or the version_id from step 2) to read the most relevant sections. Read more than one if the first does not settle it, including definitions.`,
    "",
    ...CITATION_RULES,
  ]);
}

function whatChangedPrompt(args: z.output<typeof ChangedArgs>): GetPromptResult {
  return message([
    `Explain what has changed in ${quoted(args.legislation)} since ${args.since}${args.provision === undefined ? "" : `, in ${quoted(args.provision)}`}.`,
    "",
    "Use the nz-legislation tools:",
    "1. search_legislation to find the work_id.",
    `2. list_versions to see the versions dated after ${args.since}.`,
    args.provision === undefined
      ? "3. Pick the provisions that matter (get_table_of_contents helps) and compare_versions each one, from_as_at the earlier date to today."
      : `3. compare_versions for that provision, from_as_at ${args.since} to today (get_table_of_contents gives the exact label).`,
    "",
    "4. To name the amending legislation, read get_provision_text with include_history true (the history notes list it). Do not name an amending Act the tool results do not show.",
    "",
    "Summarise each change in plain language with its version date. Versions show the law as at each date: check the amending legislation for when changes commence and what they apply to.",
    ...CITATION_RULES,
  ]);
}

/** Registers the prompts. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "find_provision",
    {
      title: "Find the provision on a topic",
      description: "Find and quote the NZ legislation provision that deals with a topic.",
      argsSchema: FindArgs,
    },
    (args) => findProvisionPrompt(args),
  );
  server.registerPrompt(
    "what_changed",
    {
      title: "What changed since a date",
      description:
        "Explain how a piece of NZ legislation (or one provision) has changed since a date.",
      argsSchema: ChangedArgs,
    },
    (args) => whatChangedPrompt(args),
  );
}
