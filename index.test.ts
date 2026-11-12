import { describe, it, expect } from "vitest";
import worker, { SearchEntrypoint, systemPromptFor } from "./src/index";
import type { AiSearchChunk, Env } from "./src/env";

const env = {
  ALLOWED_ORIGINS:
    "https://docs.example.com,https://www.docs.example.com,https://skyphusion.net,https://www.skyphusion.net",
  GENERATION_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
} as unknown as Env;

function req(path: string, init?: RequestInit): Request {
  return new Request("https://search.example.com" + path, init);
}

const call = (r: Request) => (worker.fetch as any)(r, env);

describe("query worker", () => {
  it("health returns ok", async () => {
    const res = await call(req("/health"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("unknown path is 404", async () => {
    const res = await call(req("/nope"));
    expect(res.status).toBe(404);
  });

  it("OPTIONS echoes an allowed origin", async () => {
    const res = await call(
      req("/ask", { method: "OPTIONS", headers: { Origin: "https://docs.example.com" } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://docs.example.com");
  });

  it("rejects a disallowed origin on /ask", async () => {
    const res = await call(
      req("/ask", {
        method: "POST",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows skyphusion.net origin on OPTIONS", async () => {
    const res = await call(
      req("/ask", { method: "OPTIONS", headers: { Origin: "https://skyphusion.net" } }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://skyphusion.net");
  });

  it("400 on invalid JSON from an allowed origin", async () => {
    const res = await call(
      req("/ask", {
        method: "POST",
        headers: { Origin: "https://docs.example.com", "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("systemPromptFor (origin -> profile)", () => {
  const base = { ASSISTANT_SYSTEM_PROMPT: "DEFAULT" } as unknown as Env;

  it("falls back to the default prompt for an unknown origin", () => {
    expect(systemPromptFor(base, "https://example.com")).toBe("DEFAULT");
  });

  it("uses a configured profile for a matching origin", () => {
    const e = {
      ASSISTANT_SYSTEM_PROMPT: "DEFAULT",
      ORIGIN_PROFILES: JSON.stringify({ "https://rockenhaus.net": "COURT RECORD PROMPT" }),
    } as unknown as Env;
    expect(systemPromptFor(e, "https://rockenhaus.net")).toBe("COURT RECORD PROMPT");
  });

  it("keeps the legacy blog special-case working", () => {
    const e = {
      ASSISTANT_SYSTEM_PROMPT: "DEFAULT",
      BLOG_ASSISTANT_SYSTEM_PROMPT: "BLOG",
    } as unknown as Env;
    expect(systemPromptFor(e, "https://skyphusion.net")).toBe("BLOG");
  });

  it("lets a configured profile override the legacy blog case", () => {
    const e = {
      ASSISTANT_SYSTEM_PROMPT: "DEFAULT",
      BLOG_ASSISTANT_SYSTEM_PROMPT: "BLOG",
      ORIGIN_PROFILES: JSON.stringify({ "https://skyphusion.net": "OVERRIDE" }),
    } as unknown as Env;
    expect(systemPromptFor(e, "https://skyphusion.net")).toBe("OVERRIDE");
  });

  it("degrades to the default when ORIGIN_PROFILES is malformed", () => {
    // A bad var must not take /ask down.
    const e = {
      ASSISTANT_SYSTEM_PROMPT: "DEFAULT",
      ORIGIN_PROFILES: "{not json",
    } as unknown as Env;
    expect(systemPromptFor(e, "https://rockenhaus.net")).toBe("DEFAULT");
  });

  it("ignores non-string and blank profile values", () => {
    const e = {
      ASSISTANT_SYSTEM_PROMPT: "DEFAULT",
      ORIGIN_PROFILES: JSON.stringify({ "https://a.com": 42, "https://b.com": "   " }),
    } as unknown as Env;
    expect(systemPromptFor(e, "https://a.com")).toBe("DEFAULT");
    expect(systemPromptFor(e, "https://b.com")).toBe("DEFAULT");
  });
});

const hit: AiSearchChunk = {
  id: "c1",
  type: "text",
  score: 0.91,
  text: "Tag deploy ships the workers.",
  item: {
    key: "search-mcp/docs/DEPLOY.md",
    metadata: { repo: "search-mcp", path: "docs/DEPLOY.md" },
  },
};

const ASK_RETRIEVAL = {
  retrieval: { retrieval_type: "hybrid", max_num_results: 6 },
  query_rewrite: { enabled: true },
};

function rpcHarness(opts?: { limited?: boolean }) {
  const searches: unknown[] = [];
  const limitKeys: string[] = [];
  let generated = 0;
  const rpcEnv = {
    ...env,
    TURNSTILE_SECRET: "turnstile-is-set",
    ASK_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limitKeys.push(key);
        return { success: opts?.limited !== true };
      },
    },
    SEARCH: {
      search: async (query: unknown) => {
        searches.push(query);
        return { search_query: "q", chunks: [hit] };
      },
      chatCompletions: async () => {
        generated += 1;
        throw new Error("generation was called");
      },
    },
  } as unknown as Env;
  return {
    entry: new SearchEntrypoint({} as ExecutionContext, rpcEnv),
    searches,
    limitKeys,
    generated: () => generated,
  };
}

describe("SearchEntrypoint", () => {
  it("is not a method on the public fetch handler", () => {
    expect((worker as { search?: unknown }).search).toBeUndefined();
  });

  it("returns retrieval hits and does not generate", async () => {
    const { entry, searches, limitKeys, generated } = rpcHarness();
    const result = await entry.search("  where is the deploy doc?  ");
    expect(result).toEqual({ chunks: [hit] });
    expect(searches).toEqual([
      {
        query: "where is the deploy doc?",
        ai_search_options: ASK_RETRIEVAL,
      },
    ]);
    expect(limitKeys).toEqual(["ask:rpc"]);
    expect(generated()).toBe(0);
  });

  it("refuses an empty question before the limiter or search", async () => {
    const { entry, searches, limitKeys } = rpcHarness();
    await expect(entry.search("")).rejects.toThrow(/^empty_question$/);
    await expect(entry.search("   ")).rejects.toThrow(/^empty_question$/);
    await expect(entry.search(" ".repeat(2001))).rejects.toThrow(/^empty_question$/);
    await expect(entry.search(undefined as unknown as string)).rejects.toThrow(/^empty_question$/);
    expect(searches).toEqual([]);
    expect(limitKeys).toEqual([]);
  });

  it("uses the same 2000 character bound as /ask", async () => {
    const { entry, searches, limitKeys } = rpcHarness();
    const atBound = "a".repeat(2000);
    const over = "b".repeat(2001);
    await expect(entry.search(over)).rejects.toThrow(/^question_too_long$/);
    expect(searches).toEqual([]);
    expect(limitKeys).toEqual([]);
    const result = await entry.search(atBound);
    expect(result.chunks).toEqual([hit]);
    expect(searches).toEqual([{ query: atBound, ai_search_options: ASK_RETRIEVAL }]);
    expect(limitKeys).toEqual(["ask:rpc"]);
  });

  it("refuses when the shared limiter says no, on a fixed key", async () => {
    const { entry, searches, limitKeys } = rpcHarness({ limited: true });
    await expect(entry.search("203.0.113.5")).rejects.toThrow(/^rate_limited$/);
    await expect(entry.search("other question")).rejects.toThrow(/^rate_limited$/);
    expect(limitKeys).toEqual(["ask:rpc", "ask:rpc"]);
    expect(searches).toEqual([]);
  });
});

describe("public /ask auth", () => {
  it("rejects a missing Turnstile token when TURNSTILE_SECRET is set", async () => {
    let limited = false;
    let searched = false;
    const guarded = {
      ...env,
      TURNSTILE_SECRET: "present",
      ASK_LIMITER: {
        limit: async () => {
          limited = true;
          return { success: true };
        },
      },
      SEARCH: {
        search: async () => {
          searched = true;
          return { chunks: [] };
        },
        chatCompletions: async () => {
          searched = true;
          return new ReadableStream();
        },
      },
    } as unknown as Env;
    const res = await (worker.fetch as typeof worker.fetch)(
      req("/ask", {
        method: "POST",
        headers: { Origin: "https://docs.example.com", "content-type": "application/json" },
        body: JSON.stringify({ question: "hello" }),
      }),
      guarded,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile_failed" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://docs.example.com");
    expect(limited).toBe(false);
    expect(searched).toBe(false);
  });

  it("still answers /ask with chatCompletions, not the RPC search call", async () => {
    const chatCalls: unknown[] = [];
    let searched = false;
    const stream = new ReadableStream();
    const open = {
      ...env,
      ASK_LIMITER: { limit: async () => ({ success: true }) },
      SEARCH: {
        search: async () => {
          searched = true;
          return { chunks: [] };
        },
        chatCompletions: async (query: unknown) => {
          chatCalls.push(query);
          return stream;
        },
      },
    } as unknown as Env;
    const res = await (worker.fetch as typeof worker.fetch)(
      req("/ask", {
        method: "POST",
        headers: { Origin: "https://docs.example.com", "content-type": "application/json" },
        body: JSON.stringify({ question: "hello" }),
      }),
      open,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(searched).toBe(false);
    expect(chatCalls).toEqual([
      {
        messages: [
          { role: "system", content: systemPromptFor(open, "https://docs.example.com") },
          { role: "user", content: "hello" },
        ],
        model: env.GENERATION_MODEL,
        stream: true,
        ai_search_options: ASK_RETRIEVAL,
      },
    ]);
  });

  it("has no public route for the RPC method", async () => {
    const res = await call(
      req("/search", {
        method: "POST",
        headers: { Origin: "https://docs.example.com", "content-type": "application/json" },
        body: JSON.stringify({ question: "hello" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
