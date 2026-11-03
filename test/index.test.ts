import { describe, expect, it } from "vitest";
import { SERVER_NAME, SERVER_TITLE, startupBanner } from "../src/index.js";

describe("package entry", () => {
  it("exposes stable identifiers", () => {
    expect(SERVER_NAME).toBe("nz-legislation-mcp");
    expect(SERVER_TITLE).toBe("NZ Legislation");
  });

  it("builds a banner that contains only the name and version", () => {
    expect(startupBanner("1.2.3")).toBe("NZ Legislation MCP server (nz-legislation-mcp) v1.2.3");
  });
});
