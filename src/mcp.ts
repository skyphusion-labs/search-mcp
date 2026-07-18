import type { McpEnv, AiSearchChunk, SearchResultChunk } from "./env";

// Bearer-gated Streamable-HTTP MCP server with a single `search` tool over a Cloudflare
// AI Search instance. Deploy separately from the public /ask query Worker when you want
// machine-to-machine retrieval without exposing the corpus through a browser widget.

const SERVER_INFO = { name: "search-mcp", version: "0.2.0" };
const PROTOCOL_VERSION = "2025-06-18";

// At most this many chunks per (repo, path) survive dedup; the rest of the budget
// backfills from other files so one long document cannot saturate the result set.
const MAX_CHUNKS_PER_PATH = 2;
// Upstream fetch ceiling (AI Search caps max_num_results at 50). We over-fetch so
// dedup and repo filtering can still fill the caller's requested count.
const UPSTREAM_FETCH_CAP = 50;

const SEARCH_TOOL = {
  name: "search",
  description:
    "Search the indexed corpus in Cloudflare AI Search. Returns the most relevant " +
    "chunks with their source object keys and scores. Results are deduplicated to at " +
    "most 2 chunks per file; pass `repos` to restrict results to specific repos.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search query." },
      max_num_results: {
        type: "number",
        description: "Maximum chunks to return (1-20, default 8).",
      },
      repos: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional repo-name filter (exact match on the corpus repo segment, " +
          "e.g. [\"postern\", \"fleet-chezmoi\"]).",
      },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      chunks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            repo: { type: "string" },
            path: { type: "string" },
            score: { type: "number" },
            text: { type: "string" },
            updated: {
              type: "number",
              description: "Source object timestamp (epoch ms), when available.",
            },
          },
          required: ["repo", "path", "score", "text"],
        },
      },
    },
    required: ["chunks"],
  },
};

function chunkKeyParts(key: string): { repo: string; path: string } {
  const slash = key.indexOf("/");
  if (slash === -1) return { repo: "unknown", path: key };
  return { repo: key.slice(0, slash), path: key.slice(slash + 1) };
}

export function mapSearchChunks(chunks: AiSearchChunk[]): SearchResultChunk[] {
  return chunks.map((c) => {
    const meta = c.item?.metadata;
    const fromKey = chunkKeyParts(c.item?.key ?? "unknown");
    const path = meta?.path ?? fromKey.path.replace(/\.txt$/, "");
    const mapped: SearchResultChunk = {
      repo: meta?.repo ?? fromKey.repo,
      path,
      score: c.score,
      text: c.text,
    };
    if (typeof c.item?.timestamp === "number") mapped.updated = c.item.timestamp;
    return mapped;
  });
}

// Post-retrieval shaping: optional exact-match repo filter, then per-path dedup.
// Chunks arrive score-ordered from AI Search, so keeping the first
// MAX_CHUNKS_PER_PATH occurrences of each (repo, path) keeps the best ones.
export function shapeResults(
  chunks: SearchResultChunk[],
  repos: string[] | undefined,
  max: number,
): SearchResultChunk[] {
  const repoSet = repos?.length ? new Set(repos) : null;
  const perPath = new Map<string, number>();
  const out: SearchResultChunk[] = [];
  for (const c of chunks) {
    if (repoSet && !repoSet.has(c.repo)) continue;
    const key = `${c.repo}/${c.path}`;
    const seen = perPath.get(key) ?? 0;
    if (seen >= MAX_CHUNKS_PER_PATH) continue;
    perPath.set(key, seen + 1);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

// MCP_TOKEN is either a single bare token (legacy, attributed as "default") or a
// comma-separated list of `name=token` entries. Returns the matched consumer name,
// or null when the presented token matches no entry.
export function matchConsumer(secret: string | undefined, presented: string): string | null {
  if (!secret || !presented) return null;
  for (const entry of secret.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? "default" : trimmed.slice(0, eq).trim();
    const token = eq === -1 ? trimmed : trimmed.slice(eq + 1).trim();
    if (token && presented === token) return name || "default";
  }
  return null;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

async function handleRpc(msg: RpcMessage, env: McpEnv): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          (params?.protocolVersion as string | undefined) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [SEARCH_TOOL] });
    case "tools/call": {
      const name = params?.name as string | undefined;
      if (name !== "search") return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = (params?.arguments as Record<string, unknown>) || {};
      const query = String(args.query ?? "").trim();
      if (!query) return rpcError(id, -32602, "Missing required argument 'query'");
      const max = Math.min(Math.max(Number(args.max_num_results) || 8, 1), 20);
      const reposArg = args.repos;
      if (
        reposArg !== undefined &&
        (!Array.isArray(reposArg) || reposArg.some((r) => typeof r !== "string"))
      ) {
        return rpcError(id, -32602, "'repos' must be an array of strings");
      }
      const repos = reposArg as string[] | undefined;
      // Over-fetch so dedup and repo filtering can still fill `max` results.
      const fetchN = Math.min(UPSTREAM_FETCH_CAP, Math.max(max * 4, 20));
      try {
        const res = await env.SEARCH.search({
          query,
          ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: fetchN } },
        });
        const chunks: AiSearchChunk[] = res.chunks || [];
        const structured = shapeResults(mapSearchChunks(chunks), repos, max);
        const text = structured.length
          ? structured
              .map(
                (c) =>
                  `# ${c.repo}/${c.path}  (score ${c.score.toFixed(3)})\n${c.text}`,
              )
              .join("\n\n---\n\n")
          : "No results.";
        return rpcResult(id, {
          content: [{ type: "text", text }],
          structuredContent: { chunks: structured },
          isError: false,
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Search failed: ${String(err)}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "search-mcp" });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);

    const auth = request.headers.get("Authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const consumer = matchConsumer(env.MCP_TOKEN, presented);
    if (!consumer) {
      return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }
    console.log(JSON.stringify({ event: "mcp_auth", consumer }));

    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let payload: RpcMessage | RpcMessage[];
    try {
      payload = (await request.json()) as RpcMessage | RpcMessage[];
    } catch {
      return json(rpcError(null, -32700, "Parse error"));
    }

    const hasId = (m: RpcMessage) => m.id !== undefined && m.id !== null;

    if (Array.isArray(payload)) {
      const responses: unknown[] = [];
      for (const m of payload) {
        if (hasId(m)) responses.push(await handleRpc(m, env));
      }
      return responses.length ? json(responses) : json(null, 202);
    }

    if (!hasId(payload)) return json(null, 202);

    return json(await handleRpc(payload, env));
  },
} satisfies ExportedHandler<McpEnv>;
