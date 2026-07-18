import { describe, it, expect } from "vitest";
import { matchConsumer, mapSearchChunks, shapeResults } from "./mcp";
import mcp from "./mcp";
import type { McpEnv, SearchResultChunk } from "./env";

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
    expect(out[0]).not.toHaveProperty("updated");
  });

  it("surfaces the item timestamp as `updated` when present", () => {
    const out = mapSearchChunks([
      {
        id: "3",
        type: "text",
        score: 0.8,
        text: "recent",
        item: { key: "postern/README.md", timestamp: 1784300000000 },
      },
    ]);
    expect(out[0]?.updated).toBe(1784300000000);
  });
});

describe("shapeResults", () => {
  const chunk = (repo: string, path: string, score: number): SearchResultChunk => ({
    repo,
    path,
    score,
    text: `${repo}/${path}@${score}`,
  });

  it("caps chunks per (repo, path) at 2 and backfills from other files", () => {
    const out = shapeResults(
      [
        chunk("a", "big.md", 0.9),
        chunk("a", "big.md", 0.89),
        chunk("a", "big.md", 0.88),
        chunk("b", "other.md", 0.5),
      ],
      undefined,
      8,
    );
    expect(out.map((c) => c.text)).toEqual([
      "a/big.md@0.9",
      "a/big.md@0.89",
      "b/other.md@0.5",
    ]);
  });

  it("filters by exact repo names when `repos` is given", () => {
    const out = shapeResults(
      [chunk("postern", "a.md", 0.9), chunk("prism", "b.md", 0.8), chunk("postern", "c.md", 0.7)],
      ["postern"],
      8,
    );
    expect(out.map((c) => c.repo)).toEqual(["postern", "postern"]);
  });

  it("truncates to max after filtering and dedup", () => {
    const out = shapeResults(
      [chunk("a", "1.md", 0.9), chunk("a", "2.md", 0.8), chunk("a", "3.md", 0.7)],
      undefined,
      2,
    );
    expect(out).toHaveLength(2);
  });

  it("treats an empty repos array as no filter", () => {
    const out = shapeResults([chunk("a", "1.md", 0.9)], [], 8);
    expect(out).toHaveLength(1);
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
