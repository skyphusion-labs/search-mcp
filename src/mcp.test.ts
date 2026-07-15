import { describe, it, expect } from "vitest";
import { matchConsumer, mapSearchChunks } from "./mcp";
import mcp from "./mcp";
import type { McpEnv } from "./env";

describe("mapSearchChunks", () => {
  it("prefers ingest metadata path over remapped object keys", () => {
    const out = mapSearchChunks([
      {
        id: "1",
        type: "text",
        score: 0.91,
        text: "chunk body",
        item: {
          key: "search-mcp/src/mcp.ts.txt",
          metadata: { repo: "search-mcp", path: "src/mcp.ts" },
        },
      },
    ]);
    expect(out).toEqual([
      { repo: "search-mcp", path: "src/mcp.ts", score: 0.91, text: "chunk body" },
    ]);
  });

  it("falls back to parsing the object key when metadata is absent", () => {
    const out = mapSearchChunks([
      {
        id: "2",
        type: "text",
        score: 0.5,
        text: "other",
        item: { key: "fleet-chezmoi/docs/README.md" },
      },
    ]);
    expect(out[0]?.repo).toBe("fleet-chezmoi");
    expect(out[0]?.path).toBe("docs/README.md");
  });
});

describe("mcp search tool", () => {
  it("returns structuredContent alongside legacy text", async () => {
    const env = {
      MCP_TOKEN: "tok",
      SEARCH: {
        search: async () => ({
          search_query: "q",
          chunks: [
            {
              id: "1",
              type: "text",
              score: 0.75,
              text: "hello",
              item: {
                key: "search-mcp/README.md",
                metadata: { repo: "search-mcp", path: "README.md" },
              },
            },
          ],
        }),
      },
    } as unknown as McpEnv;

    const res = await mcp.fetch(
      new Request("https://search.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer tok",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search", arguments: { query: "hello" } },
        }),
      }),
      env,
    );
    const body = (await res.json()) as {
      result: {
        content: { type: string; text: string }[];
        structuredContent: { chunks: { repo: string; path: string; score: number; text: string }[] };
      };
    };
    expect(body.result.structuredContent.chunks).toEqual([
      { repo: "search-mcp", path: "README.md", score: 0.75, text: "hello" },
    ]);
    expect(body.result.content[0]?.text).toContain("# search-mcp/README.md");
  });
});

describe("matchConsumer", () => {
  it("accepts a legacy bare token as 'default'", () => {
    expect(matchConsumer("tok-abc", "tok-abc")).toBe("default");
    expect(matchConsumer("tok-abc", "tok-xyz")).toBeNull();
  });
  it("matches named entries and attributes the consumer", () => {
    const secret = "agent-a=tok-a, agent-b=tok-b";
    expect(matchConsumer(secret, "tok-a")).toBe("agent-a");
    expect(matchConsumer(secret, "tok-b")).toBe("agent-b");
    expect(matchConsumer(secret, "tok-other")).toBeNull();
  });
  it("fails closed on unset secret or empty presentation", () => {
    expect(matchConsumer(undefined, "tok")).toBeNull();
    expect(matchConsumer("", "tok")).toBeNull();
    expect(matchConsumer("agent=tok", "")).toBeNull();
  });
});
