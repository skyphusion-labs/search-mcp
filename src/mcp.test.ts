import { describe, it, expect } from "vitest";
import {
  matchConsumer,
  mapSearchChunks,
  shapeResults,
  normalizePathPrefixes,
  parseCorpusRepos,
  objectKeysForFile,
  getFileByteLimits,
} from "./mcp";
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

  it("filters by path_prefix", () => {
    const out = shapeResults(
      [
        chunk("a", "docs/x.md", 0.9),
        chunk("a", "src/y.ts", 0.8),
        chunk("a", "docs/z.md", 0.7),
      ],
      undefined,
      8,
      { pathPrefixes: ["docs/"] },
    );
    expect(out.map((c) => c.path)).toEqual(["docs/x.md", "docs/z.md"]);
  });

  it("filters by min_score", () => {
    const out = shapeResults(
      [chunk("a", "1.md", 0.9), chunk("a", "2.md", 0.4), chunk("a", "3.md", 0.7)],
      undefined,
      8,
      { minScore: 0.5 },
    );
    expect(out.map((c) => c.score)).toEqual([0.9, 0.7]);
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

describe("normalizePathPrefixes", () => {
  it("normalizes string and array forms", () => {
    expect(normalizePathPrefixes("docs/")).toEqual(["docs/"]);
    expect(normalizePathPrefixes([" a ", "b"])).toEqual(["a", "b"]);
    expect(normalizePathPrefixes("")).toBeUndefined();
    expect(normalizePathPrefixes(undefined)).toBeUndefined();
  });
});

describe("parseCorpusRepos", () => {
  it("parses JSON array, object, and CSV", () => {
    expect(parseCorpusRepos('["a","b"]').repos).toEqual(["a", "b"]);
    expect(parseCorpusRepos('{"repos":["x"],"description":"d"}')).toEqual({
      repos: ["x"],
      description: "d",
    });
    expect(parseCorpusRepos("a, b").repos).toEqual(["a", "b"]);
  });
});

describe("objectKeysForFile", () => {
  it("tries bare path and .txt remap", () => {
    expect(objectKeysForFile("repo", "src/a.ts")).toEqual([
      "repo/src/a.ts",
      "repo/src/a.ts.txt",
    ]);
  });
});

describe("getFileByteLimits", () => {
  it("applies soft/hard defaults", () => {
    const d = getFileByteLimits({ SEARCH: {} as McpEnv["SEARCH"] });
    expect(d.soft).toBe(65536);
    expect(d.hard).toBe(262144);
  });
});

describe("mcp tools surface", () => {
  function envWithSearch(extra: Partial<McpEnv> = {}): McpEnv {
    return {
      MCP_TOKEN: "tok",
      CORPUS_REPOS: JSON.stringify(["search-mcp", "postern"]),
      SEARCH: {
        search: async (q: { query?: string; ai_search_options?: { retrieval?: { retrieval_type?: string }; query_rewrite?: { enabled?: boolean } } }) => {
          // echo retrieval knobs into a fake chunk for assertions
          const rt = q.ai_search_options?.retrieval?.retrieval_type ?? "hybrid";
          const rw = q.ai_search_options?.query_rewrite?.enabled;
          return {
            search_query: q.query ?? "",
            chunks: [
              {
                id: "1",
                type: "text",
                score: 0.75,
                text: `hello rt=${rt} rw=${rw}`,
                item: {
                  key: "search-mcp/README.md",
                  metadata: { repo: "search-mcp", path: "README.md" },
                },
              },
              {
                id: "2",
                type: "text",
                score: 0.2,
                text: "low",
                item: {
                  key: "search-mcp/docs/x.md",
                  metadata: { repo: "search-mcp", path: "docs/x.md" },
                },
              },
            ],
          };
        },
        chatCompletions: async () => ({
          id: "c1",
          model: "test-model",
          choices: [{ message: { role: "assistant", content: "grounded answer" }, finish_reason: "stop" }],
          chunks: [
            {
              id: "1",
              type: "text",
              score: 0.9,
              text: "cite me",
              item: {
                key: "search-mcp/README.md",
                metadata: { repo: "search-mcp", path: "README.md" },
              },
            },
          ],
        }),
      },
      ...extra,
    } as unknown as McpEnv;
  }

  async function call(env: McpEnv, name: string, args: Record<string, unknown> = {}) {
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
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    return (await res.json()) as {
      result: {
        content: { type: string; text: string }[];
        structuredContent?: unknown;
        isError?: boolean;
      };
    };
  }

  it("returns structuredContent for search", async () => {
    const body = await call(envWithSearch(), "search", { query: "hello" });
    const chunks = (body.result.structuredContent as { chunks: { path: string; text: string }[] })
      .chunks;
    expect(chunks[0]).toEqual({
      repo: "search-mcp",
      path: "README.md",
      score: 0.75,
      text: "hello rt=hybrid rw=true",
    });
    expect(chunks.map((c) => c.path)).toEqual(["README.md", "docs/x.md"]);
    expect(body.result.content[0]?.text).toContain("# search-mcp/README.md");
  });

  it("applies keyword retrieval and rewrite defaults", async () => {
    const body = await call(envWithSearch(), "search", {
      query: "MCP_TOKEN",
      retrieval_type: "keyword",
    });
    const chunks = (body.result.structuredContent as { chunks: { text: string }[] }).chunks;
    expect(chunks[0]?.text).toContain("rt=keyword");
    expect(chunks[0]?.text).toContain("rw=false");
  });

  it("filters min_score", async () => {
    const body = await call(envWithSearch(), "search", {
      query: "hello",
      min_score: 0.5,
      max_num_results: 10,
    });
    const chunks = (body.result.structuredContent as { chunks: { path: string }[] }).chunks;
    expect(chunks.map((c) => c.path)).toEqual(["README.md"]);
  });

  it("filters path_prefix", async () => {
    const body = await call(envWithSearch(), "search", {
      query: "hello",
      path_prefix: "docs/",
      max_num_results: 10,
    });
    const chunks = (body.result.structuredContent as { chunks: { path: string }[] }).chunks;
    expect(chunks.map((c) => c.path)).toEqual(["docs/x.md"]);
  });

  it("list_repos uses CORPUS_REPOS config", async () => {
    const body = await call(envWithSearch(), "list_repos", {});
    expect(body.result.structuredContent).toMatchObject({
      repos: ["search-mcp", "postern"],
      source: "config",
    });
  });

  it("get_file requires CORPUS binding", async () => {
    const body = await call(envWithSearch(), "get_file", { repo: "a", path: "b.md" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("CORPUS");
  });

  it("get_file reads R2 object", async () => {
    const env = envWithSearch({
      CORPUS: {
        get: async (key: string) => {
          if (key === "search-mcp/README.md" || key === "search-mcp/README.md.txt") {
            const body = "file body here";
            return {
              size: body.length,
              arrayBuffer: async () => new TextEncoder().encode(body).buffer,
              text: async () => body,
            };
          }
          return null;
        },
      } as unknown as R2Bucket,
    });
    const body = await call(env, "get_file", { repo: "search-mcp", path: "README.md" });
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0]?.text).toContain("file body here");
  });

  it("ask returns answer and sources", async () => {
    const body = await call(envWithSearch(), "ask", { question: "What is this?" });
    expect(body.result.content[0]?.text).toContain("grounded answer");
    expect(body.result.content[0]?.text).toContain("Sources");
    expect(body.result.structuredContent).toMatchObject({
      answer: "grounded answer",
    });
  });

  it("corpus_status reports missing meta", async () => {
    const body = await call(envWithSearch(), "corpus_status", {});
    expect(body.result.structuredContent).toMatchObject({ ok: false });
  });

  it("lists tools and resources", async () => {
    const env = envWithSearch();
    const tools = await mcp.fetch(
      new Request("https://search.example.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    const toolsBody = (await tools.json()) as { result: { tools: { name: string }[] } };
    expect(toolsBody.result.tools.map((t) => t.name).sort()).toEqual(
      ["ask", "corpus_status", "get_file", "list_repos", "search"].sort(),
    );

    const res = await mcp.fetch(
      new Request("https://search.example.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }),
      }),
      env,
    );
    const resBody = (await res.json()) as { result: { resources: { uri: string }[] } };
    expect(resBody.result.resources.map((r) => r.uri).sort()).toEqual(
      ["corpus://catalog", "corpus://skill"].sort(),
    );

    const read = await mcp.fetch(
      new Request("https://search.example.com/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "corpus://skill" },
        }),
      }),
      env,
    );
    const readBody = (await read.json()) as {
      result: { contents: { text: string }[] };
    };
    expect(readBody.result.contents[0]?.text).toContain("list_repos");
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
