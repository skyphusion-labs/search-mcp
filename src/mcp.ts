import type {
  McpEnv,
  AiSearchChunk,
  SearchResultChunk,
  CorpusStatus,
  AiSearchOptions,
  AiSearchChatResponse,
} from "./env";

// Bearer-gated Streamable-HTTP MCP server over a Cloudflare AI Search instance
// (and optional R2 corpus bucket). Deploy separately from the public /ask query Worker.

const SERVER_INFO = { name: "search-mcp", version: "0.5.1" };
const PROTOCOL_VERSION = "2025-06-18";

// At most this many chunks per (repo, path) survive dedup; the rest of the budget
// backfills from other files so one long document cannot saturate the result set.
const MAX_CHUNKS_PER_PATH = 2;
// Upstream fetch ceiling (AI Search caps max_num_results at 50). We over-fetch so
// dedup and repo filtering can still fill the caller's requested count.
const UPSTREAM_FETCH_CAP = 50;

const DEFAULT_GET_FILE_MAX = 64 * 1024;
const DEFAULT_GET_FILE_HARD_MAX = 256 * 1024;
const CORPUS_STATUS_KEY = "_meta/corpus-status.json";

const CORPUS_BLURB =
  "Corpus is git-synced documentation and source under Cloudflare AI Search " +
  "(internal instance on this MCP). Keys look like <repo>/<path>. " +
  "Prefer list_repos first, then search with repos/path_prefix, then get_file for full context. " +
  "Use keyword retrieval for identifiers; hybrid (default) for natural language. " +
  "ask synthesizes a grounded answer with citations; search returns raw chunks only.";

const AGENT_SKILL = `# search-mcp agent skill

## Tools
1. **list_repos** -- discover exact repo names for filters.
2. **search** -- hybrid (default) / keyword / vector retrieval with optional repos, path_prefix, min_score, rewrite.
3. **get_file** -- read a corpus object (repo + path), size-capped; try after a search hit.
4. **ask** -- one grounded answer from the corpus (chat + citations). Prefer when you need prose, not raw chunks.
5. **corpus_status** -- last sync metadata when the operator wrote _meta/corpus-status.json.

## Resources
- corpus://catalog -- repos + blurb
- corpus://skill -- this guide

## Patterns
- Symbol or flag name: search with retrieval_type=keyword, rewrite=false, repos=[...]
- "How does X work?": search hybrid, then get_file on top hits, or ask
- Always pass exact repo names from list_repos (not guessed)
- path_prefix is a string prefix on path (e.g. "docs/" or "src/mcp.ts")
`;

type JsonSchema = Record<string, unknown>;

interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

const TOOLS: McpTool[] = [
  {
    name: "list_repos",
    description:
      "List repository names present in this MCP's corpus (exact strings for the search.repos filter). " +
      CORPUS_BLURB,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search",
    description:
      "Search the indexed corpus. Returns relevant chunks with repo, path, score, and text. " +
      "Deduplicated to at most 2 chunks per file. " +
      CORPUS_BLURB,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language or keyword search query." },
        max_num_results: {
          type: "number",
          description: "Maximum chunks to return (1-20, default 8).",
        },
        repos: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional repo-name filter (exact match, e.g. [\"postern\", \"fleet-chezmoi\"]). Use list_repos for names.",
        },
        path_prefix: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description:
            "Optional path prefix filter (e.g. \"docs/\" or [\"src/\", \"docs/\"]). Match is on path only.",
        },
        retrieval_type: {
          type: "string",
          enum: ["hybrid", "keyword", "vector"],
          description: "Retrieval mode (default hybrid). Prefer keyword for identifiers/symbols.",
        },
        rewrite: {
          type: "boolean",
          description: "Enable AI Search query rewrite (default true for hybrid/vector, false for keyword).",
        },
        min_score: {
          type: "number",
          description: "Drop chunks with score strictly below this value (0-1 scale from upstream).",
        },
        rerank: {
          type: "boolean",
          description: "Enable upstream reranking when supported (default false).",
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
              updated: { type: "number" },
            },
            required: ["repo", "path", "score", "text"],
          },
        },
      },
      required: ["chunks"],
    },
  },
  {
    name: "get_file",
    description:
      "Read a single corpus file by repo and path (R2 object). Size-capped. " +
      "Requires CORPUS R2 binding. Use after search when you need more than a chunk.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository segment (exact)." },
        path: { type: "string", description: "Path within the repo (as in search hits)." },
        max_bytes: {
          type: "number",
          description: "Max bytes to return (default 65536, hard cap 262144).",
        },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "ask",
    description:
      "Ask a natural-language question and get one grounded answer from the corpus " +
      "(chatCompletions + retrieval). Prefer search + get_file when you need raw evidence. " +
      CORPUS_BLURB,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to answer from the corpus." },
        repos: {
          type: "array",
          items: { type: "string" },
          description: "Optional repo filter applied to citation chunks (best-effort).",
        },
        path_prefix: {
          oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "Optional path prefix filter on citation chunks.",
        },
        max_num_results: {
          type: "number",
          description: "Retrieval budget for grounding (1-20, default 8).",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "corpus_status",
    description:
      "Return last corpus sync metadata when present (_meta/corpus-status.json in R2, " +
      "or CORPUS_REPOS-only fallback). Use to judge freshness.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const RESOURCES = [
  {
    uri: "corpus://catalog",
    name: "Corpus catalog",
    description: "Repo list and short corpus blurb for this MCP instance.",
    mimeType: "application/json",
  },
  {
    uri: "corpus://skill",
    name: "Agent skill",
    description: "How agents should use search-mcp tools.",
    mimeType: "text/markdown",
  },
];

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

export function normalizePathPrefixes(
  pathPrefix: unknown,
): string[] | undefined {
  if (pathPrefix === undefined || pathPrefix === null) return undefined;
  if (typeof pathPrefix === "string") {
    const s = pathPrefix.trim();
    return s ? [s] : undefined;
  }
  if (Array.isArray(pathPrefix)) {
    const out = pathPrefix
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

// Post-retrieval shaping: optional exact-match repo filter, path prefix, min score,
// then per-path dedup. Chunks arrive score-ordered from AI Search.
export function shapeResults(
  chunks: SearchResultChunk[],
  repos: string[] | undefined,
  max: number,
  opts: { pathPrefixes?: string[]; minScore?: number } = {},
): SearchResultChunk[] {
  const repoSet = repos?.length ? new Set(repos) : null;
  const prefixes = opts.pathPrefixes;
  const minScore = opts.minScore;
  const perPath = new Map<string, number>();
  const out: SearchResultChunk[] = [];
  for (const c of chunks) {
    if (repoSet && !repoSet.has(c.repo)) continue;
    if (typeof minScore === "number" && Number.isFinite(minScore) && c.score < minScore) {
      continue;
    }
    if (prefixes?.length) {
      const ok = prefixes.some((p) => c.path === p || c.path.startsWith(p));
      if (!ok) continue;
    }
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

export function parseCorpusRepos(raw: string | undefined): {
  repos: string[];
  description?: string;
} {
  if (!raw?.trim()) return { repos: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { repos: parsed.filter((x): x is string => typeof x === "string" && !!x.trim()) };
    }
    if (parsed && typeof parsed === "object") {
      const o = parsed as { repos?: unknown; description?: unknown };
      const repos = Array.isArray(o.repos)
        ? o.repos.filter((x): x is string => typeof x === "string" && !!x.trim())
        : [];
      const description = typeof o.description === "string" ? o.description : undefined;
      return { repos, description };
    }
  } catch {
    // treat as comma-separated list
    return {
      repos: raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  return { repos: [] };
}

export function objectKeysForFile(repo: string, path: string): string[] {
  const cleanRepo = repo.replace(/^\/+|\/+$/g, "");
  const cleanPath = path.replace(/^\/+/, "");
  const keys = [`${cleanRepo}/${cleanPath}`];
  if (!cleanPath.endsWith(".txt")) keys.push(`${cleanRepo}/${cleanPath}.txt`);
  return keys;
}

export function getFileByteLimits(env: McpEnv): { soft: number; hard: number } {
  const soft = Math.max(1024, Number(env.GET_FILE_MAX_BYTES) || DEFAULT_GET_FILE_MAX);
  const hard = Math.max(
    soft,
    Number(env.GET_FILE_HARD_MAX_BYTES) || DEFAULT_GET_FILE_HARD_MAX,
  );
  return { soft, hard };
}

async function listReposFromR2(bucket: R2Bucket): Promise<string[]> {
  const repos: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ delimiter: "/", cursor, limit: 1000 });
    for (const p of page.delimitedPrefixes || []) {
      const name = p.replace(/\/$/, "");
      if (name && name !== "_meta") repos.push(name);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return repos.sort();
}

async function resolveRepos(env: McpEnv): Promise<{
  repos: string[];
  source: "config" | "r2" | "empty";
  description?: string;
}> {
  const fromConfig = parseCorpusRepos(env.CORPUS_REPOS);
  if (fromConfig.repos.length) {
    return { repos: fromConfig.repos, source: "config", description: fromConfig.description };
  }
  if (env.CORPUS) {
    try {
      const repos = await listReposFromR2(env.CORPUS);
      return { repos, source: "r2" };
    } catch (err) {
      console.log("listReposFromR2 failed", String(err));
    }
  }
  return { repos: [], source: "empty" };
}

async function readCorpusStatus(env: McpEnv): Promise<CorpusStatus | null> {
  if (!env.CORPUS) return null;
  try {
    const obj = await env.CORPUS.get(CORPUS_STATUS_KEY);
    if (!obj) return null;
    const text = await obj.text();
    const parsed = JSON.parse(text) as CorpusStatus;
    if (!parsed || typeof parsed.ts !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatChunksText(chunks: SearchResultChunk[]): string {
  if (!chunks.length) return "No results.";
  return chunks
    .map((c) => `# ${c.repo}/${c.path}  (score ${c.score.toFixed(3)})\n${c.text}`)
    .join("\n\n---\n\n");
}

function toolOk(id: unknown, text: string, structured?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      ...(structured !== undefined ? { structuredContent: structured } : {}),
      isError: false,
    },
  };
}

function toolErr(id: unknown, text: string) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError: true,
    },
  };
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

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function parseReposArg(reposArg: unknown): string[] | undefined | "bad" {
  if (reposArg === undefined) return undefined;
  if (!Array.isArray(reposArg) || reposArg.some((r) => typeof r !== "string")) return "bad";
  return reposArg as string[];
}

async function callSearch(
  env: McpEnv,
  args: Record<string, unknown>,
): Promise<{ chunks: SearchResultChunk[] } | { error: string }> {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "Missing required argument 'query'" };
  const max = Math.min(Math.max(Number(args.max_num_results) || 8, 1), 20);
  const repos = parseReposArg(args.repos);
  if (repos === "bad") return { error: "'repos' must be an array of strings" };
  const pathPrefixes = normalizePathPrefixes(args.path_prefix);
  if (args.path_prefix !== undefined && pathPrefixes === undefined && args.path_prefix !== "") {
    // invalid type (not string/array of strings)
    if (typeof args.path_prefix !== "string" && !Array.isArray(args.path_prefix)) {
      return { error: "'path_prefix' must be a string or array of strings" };
    }
  }
  const retrievalTypeRaw = String(args.retrieval_type ?? "hybrid");
  const retrieval_type =
    retrievalTypeRaw === "keyword" || retrievalTypeRaw === "vector" || retrievalTypeRaw === "hybrid"
      ? retrievalTypeRaw
      : null;
  if (!retrieval_type) return { error: "'retrieval_type' must be hybrid, keyword, or vector" };

  let rewrite = args.rewrite;
  if (rewrite === undefined) rewrite = retrieval_type !== "keyword";
  if (typeof rewrite !== "boolean") return { error: "'rewrite' must be a boolean" };

  let minScore: number | undefined;
  if (args.min_score !== undefined) {
    minScore = Number(args.min_score);
    if (!Number.isFinite(minScore)) return { error: "'min_score' must be a number" };
  }

  const rerank = args.rerank === true;
  const fetchN = Math.min(UPSTREAM_FETCH_CAP, Math.max(max * 4, 20));
  const ai_search_options: AiSearchOptions = {
    retrieval: { retrieval_type, max_num_results: fetchN },
    query_rewrite: { enabled: rewrite },
  };
  if (rerank) ai_search_options.reranking = { enabled: true };

  try {
    const res = await env.SEARCH.search({ query, ai_search_options });
    const chunks = shapeResults(mapSearchChunks(res.chunks || []), repos, max, {
      pathPrefixes,
      minScore,
    });
    return { chunks };
  } catch (err) {
    return { error: `Search failed: ${String(err)}` };
  }
}

async function callGetFile(
  env: McpEnv,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: unknown } | { error: string }> {
  if (!env.CORPUS) {
    return {
      error:
        "get_file unavailable: CORPUS R2 binding is not configured on this MCP Worker.",
    };
  }
  const repo = String(args.repo ?? "").trim();
  const path = String(args.path ?? "").trim();
  if (!repo || !path) return { error: "Missing required arguments 'repo' and 'path'" };
  if (repo.includes("..") || path.includes("..")) {
    return { error: "repo/path must not contain '..'" };
  }
  const { soft, hard } = getFileByteLimits(env);
  let maxBytes = Number(args.max_bytes) || soft;
  if (!Number.isFinite(maxBytes) || maxBytes < 1) maxBytes = soft;
  maxBytes = Math.min(Math.floor(maxBytes), hard);

  const keys = objectKeysForFile(repo, path);
  let obj: R2ObjectBody | null = null;
  let usedKey = keys[0]!;
  for (const key of keys) {
    obj = await env.CORPUS.get(key);
    if (obj) {
      usedKey = key;
      break;
    }
  }
  if (!obj) {
    return { error: `Not found: ${repo}/${path} (tried ${keys.join(", ")})` };
  }
  const size = obj.size;
  const buf = await obj.arrayBuffer();
  const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
  const text = new TextDecoder("utf-8").decode(slice);
  const truncated = size > maxBytes || buf.byteLength > maxBytes;
  const structured = {
    repo,
    path,
    key: usedKey,
    bytes: slice.byteLength,
    object_size: size,
    truncated,
    text,
  };
  const header = truncated
    ? `# ${repo}/${path} (truncated to ${slice.byteLength} of ${size} bytes)\n`
    : `# ${repo}/${path} (${size} bytes)\n`;
  return { text: header + text, structured };
}

async function callAsk(
  env: McpEnv,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: unknown } | { error: string }> {
  const question = String(args.question ?? "").trim();
  if (!question) return { error: "Missing required argument 'question'" };
  if (question.length > 4000) return { error: "question too long (max 4000 chars)" };
  const repos = parseReposArg(args.repos);
  if (repos === "bad") return { error: "'repos' must be an array of strings" };
  const pathPrefixes = normalizePathPrefixes(args.path_prefix);
  const max = Math.min(Math.max(Number(args.max_num_results) || 8, 1), 20);
  // Match the public query Worker default used in production (skyphusion-search).
  const model = env.GENERATION_MODEL?.trim() || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const system =
    env.ASSISTANT_SYSTEM_PROMPT?.trim() ||
    "You are a documentation assistant. Answer only from the retrieved corpus context. " +
      "If the context does not contain the answer, say so plainly. Prefer concrete file paths. Be concise.";

  try {
    // Prefer non-stream chatCompletions for a single MCP text payload.
    const result = await env.SEARCH.chatCompletions({
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
      model,
      stream: false,
      ai_search_options: {
        retrieval: { retrieval_type: "hybrid", max_num_results: Math.min(20, max) },
        query_rewrite: { enabled: true },
      },
    });

    if (result instanceof ReadableStream) {
      // Fallback: drain SSE-ish stream to text
      const reader = result.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
      }
      acc += dec.decode();
      return {
        text: acc || "Empty answer stream.",
        structured: { answer: acc, chunks: [] },
      };
    }

    const chat = result as AiSearchChatResponse;
    const answer = chat.choices?.[0]?.message?.content ?? "";
    let chunks = mapSearchChunks(chat.chunks || []);
    chunks = shapeResults(chunks, repos, max, { pathPrefixes });
    const cites = chunks.length
      ? "\n\n## Sources\n" +
        chunks.map((c) => `- ${c.repo}/${c.path} (score ${c.score.toFixed(3)})`).join("\n")
      : "";
    return {
      text: (answer || "No answer.") + cites,
      structured: { answer, chunks, model: chat.model },
    };
  } catch (err) {
    return { error: `ask failed: ${String(err)}` };
  }
}

async function handleToolCall(
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  env: McpEnv,
): Promise<unknown> {
  switch (name) {
    case "list_repos": {
      const { repos, source, description } = await resolveRepos(env);
      const structured = { repos, source, description: description ?? CORPUS_BLURB };
      const text =
        repos.length === 0
          ? `No repos configured (source=${source}). Set CORPUS_REPOS or bind CORPUS R2.\n\n${CORPUS_BLURB}`
          : `Repos (${source}):\n${repos.map((r) => `- ${r}`).join("\n")}\n\n${description ?? CORPUS_BLURB}`;
      return toolOk(id, text, structured);
    }
    case "search": {
      const out = await callSearch(env, args);
      if ("error" in out) return toolErr(id, out.error);
      return toolOk(id, formatChunksText(out.chunks), { chunks: out.chunks });
    }
    case "get_file": {
      const out = await callGetFile(env, args);
      if ("error" in out) return toolErr(id, out.error);
      return toolOk(id, out.text, out.structured);
    }
    case "ask": {
      const out = await callAsk(env, args);
      if ("error" in out) return toolErr(id, out.error);
      return toolOk(id, out.text, out.structured);
    }
    case "corpus_status": {
      const status = await readCorpusStatus(env);
      const catalog = await resolveRepos(env);
      if (!status) {
        const structured = {
          ok: false,
          note:
            "No _meta/corpus-status.json in CORPUS R2 (or CORPUS unbound). " +
            "Sync writes this after a successful upload.",
          repos: catalog.repos,
          source: catalog.source,
        };
        return toolOk(
          id,
          JSON.stringify(structured, null, 2),
          structured,
        );
      }
      return toolOk(id, JSON.stringify(status, null, 2), status);
    }
    default:
      return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  }
}

async function handleResourcesRead(uri: string, env: McpEnv): Promise<unknown> {
  if (uri === "corpus://skill") {
    return {
      contents: [{ uri, mimeType: "text/markdown", text: AGENT_SKILL }],
    };
  }
  if (uri === "corpus://catalog") {
    const catalog = await resolveRepos(env);
    const status = await readCorpusStatus(env);
    const body = {
      blurb: CORPUS_BLURB,
      repos: catalog.repos,
      source: catalog.source,
      description: catalog.description,
      status,
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
}

async function handleRpc(msg: RpcMessage, env: McpEnv): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion:
          (params?.protocolVersion as string | undefined) || PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      if (!name) return rpcError(id, -32602, "Missing tool name");
      const args = (params?.arguments as Record<string, unknown>) || {};
      return handleToolCall(id, name, args, env);
    }
    case "resources/list":
      return rpcResult(id, { resources: RESOURCES });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });
    case "resources/read": {
      const uri = String(params?.uri ?? "");
      if (!uri) return rpcError(id, -32602, "Missing resource uri");
      try {
        return rpcResult(id, await handleResourcesRead(uri, env));
      } catch (err) {
        return rpcError(id, -32602, String(err));
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
      return json({ ok: true, service: "search-mcp", version: SERVER_INFO.version });
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
