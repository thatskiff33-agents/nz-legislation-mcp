import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";

describe("package entry", () => {
  it("exposes stable identifiers and the server factory", () => {
    expect(entry.SERVER_NAME).toBe("nz-legislation-mcp");
    expect(entry.SERVER_TITLE).toBe("NZ Legislation");
    expect(typeof entry.VERSION).toBe("string");
    expect(typeof entry.createServer).toBe("function");
    expect(entry.TOOLS.map((t) => t.name)).toEqual([
      "search_legislation",
      "get_legislation",
      "list_versions",
      "get_table_of_contents",
      "get_provision_text",
      "compare_versions",
      "get_api_quota",
    ]);
  });
});
