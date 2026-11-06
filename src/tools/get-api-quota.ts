/** get_api_quota: the last rate-limit figures seen from the API (makes no API call). */
import { z } from "zod";
import { API_LIMITS } from "../domain/vocabulary.js";
import { defineTool } from "./shared.js";

const OutputSchema = z.object({
  known: z.boolean().describe("False until the first API call in this session."),
  daily_limit: z.number().int().nullable(),
  remaining: z.number().int().nullable(),
  resets_at: z.string().nullable().describe("ISO timestamp (midnight New Zealand time)."),
  observed_at: z.string().nullable(),
  note: z.string(),
});

export const getApiQuota = defineTool({
  name: "get_api_quota",
  title: "API quota status",
  description: `Show how many Legislation API requests remain today for this API key (${API_LIMITS.dailyRequests.toLocaleString("en-NZ")} per day by default, resetting at midnight NZ time). Uses the last figures seen; makes no API call.`,
  inputSchema: z.strictObject({}),
  outputSchema: OutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run(_args, { client }) {
    const quota = client.quota;
    const note = `There is also a limit of ${API_LIMITS.burstRequests.toLocaleString("en-NZ")} requests per IP address per ${String(API_LIMITS.burstMinutes)} minutes, which is not reported by the API.`;
    if (quota === undefined) {
      return Promise.resolve({
        known: false,
        daily_limit: null,
        remaining: null,
        resets_at: null,
        observed_at: null,
        note: `No API call has been made yet in this session. ${note}`,
      });
    }
    return Promise.resolve({
      known: true,
      daily_limit: quota.limit,
      remaining: quota.remaining,
      resets_at: new Date(quota.resetEpochSeconds * 1000).toISOString(),
      observed_at: new Date(quota.observedAt).toISOString(),
      note,
    });
  },
});
