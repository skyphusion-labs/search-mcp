import type { McpEnv, AiSearchChunk } from "./env";

// Bearer-gated Streamable-HTTP MCP server with a single `search` tool over a Cloudflare
// AI Search instance. Deploy separately from the public /ask query Worker when you want
// machine-to-machine retrieval without exposing the corpus through a browser widget.

const SERVER_INFO = { name: "search-mcp", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

const SEARCH_TOOL = {
  name: "search",
  description:
    "Search the indexed corpus in Cloudflare AI Search. Returns the most relevant " +
    "chunks with their source object keys and scores.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search query." },
      max_num_results: {
        type: "number",
        description: "Maximum chunks to return (1-20, default 8).",
      },
    },
    required: ["query"],
  },
};

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
      try {
        const res = await env.SEARCH.search({
          query,
          ai_search_options: { retrieval: { retrieval_type: "hybrid", max_num_results: max } },
        });
        const chunks: AiSearchChunk[] = res.chunks || [];
        const text = chunks.length
          ? chunks
              .map(
                (c) =>
                  `# ${c.item?.key ?? "unknown"}  (score ${c.score.toFixed(3)})\n${c.text}`,
              )
              .join("\n\n---\n\n")
          : "No results.";
        return rpcResult(id, { content: [{ type: "text", text }], isError: false });
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
