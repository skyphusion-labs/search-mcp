// Hand-authored binding surface. Every wrangler binding is mirrored here; we do not
// generate worker-configuration.d.ts. AI Search types are not yet in the pinned
// @cloudflare/workers-types, so the instance-binding shape is declared here from the
// documented Workers binding API (search / chatCompletions).

export interface AiSearchMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string;
}

export interface AiSearchOptions {
  retrieval?: {
    retrieval_type?: "vector" | "keyword" | "hybrid";
    match_threshold?: number;
    max_num_results?: number;
    context_expansion?: number;
  };
  query_rewrite?: { enabled?: boolean; model?: string; rewrite_prompt?: string };
  reranking?: { enabled?: boolean; model?: string; match_threshold?: number };
}

export interface AiSearchQuery {
  messages?: AiSearchMessage[];
  query?: string;
  model?: string;
  stream?: boolean;
  ai_search_options?: AiSearchOptions;
}

export interface AiSearchChunkMetadata {
  repo?: string;
  path?: string;
  lang?: string;
  kind?: string;
}

export interface AiSearchChunk {
  id: string;
  type: string;
  score: number;
  text: string;
  item: { key: string; timestamp?: number; metadata?: AiSearchChunkMetadata };
}

export interface SearchResultChunk {
  repo: string;
  path: string;
  score: number;
  text: string;
  // R2 object timestamp (epoch ms) when AI Search surfaces it; consumers can weigh recency.
  updated?: number;
}

export interface AiSearchSearchResponse {
  search_query: string;
  chunks: AiSearchChunk[];
}

export interface AiSearchChatResponse {
  id: string;
  model: string;
  choices: { message: { role: string; content: string }; finish_reason: string }[];
  chunks?: AiSearchChunk[];
}

// The instance binding. With `stream: true`, chatCompletions resolves to a
// ReadableStream of SSE bytes; otherwise to a parsed response object.
export interface AiSearchInstance {
  search(query: AiSearchQuery): Promise<AiSearchSearchResponse>;
  chatCompletions(
    query: AiSearchQuery,
  ): Promise<ReadableStream<Uint8Array> | AiSearchChatResponse>;
}

/** Written by corpus sync to R2 key `_meta/corpus-status.json` (and optional MCP cache). */
export interface CorpusStatus {
  ts: number;
  ok: boolean;
  target?: string;
  bucket?: string;
  instance?: string;
  objectCount?: number;
  repos?: string[];
  note?: string;
}

export interface Env {
  SEARCH: AiSearchInstance;
  ASK_LIMITER: RateLimit;
  // Secret (wrangler secret put). When unset, Turnstile verification is skipped
  // (self-host / pre-widget dev friendly) and logged.
  TURNSTILE_SECRET?: string;
  ALLOWED_ORIGINS: string;
  GENERATION_MODEL: string;
  ASSISTANT_SYSTEM_PROMPT?: string;
  BLOG_ASSISTANT_SYSTEM_PROMPT?: string;
  // JSON object mapping an exact request Origin to the system prompt for
  // that site. Replaces a hardcoded origin list in src/index.ts, so serving
  // another site becomes configuration rather than a code change. Malformed
  // values are logged and ignored; the default prompt applies.
  ORIGIN_PROFILES?: string;
}

export interface McpEnv {
  SEARCH: AiSearchInstance;
  // Secret (wrangler secret put MCP_TOKEN -c wrangler.mcp.toml). Either a single bare
  // token or comma-separated per-consumer `name=token` entries. Every /mcp request must
  // present `Authorization: Bearer <token>`. When unset, the Worker refuses all
  // requests (fail closed).
  MCP_TOKEN?: string;
  // Optional R2 bucket holding the same corpus AI Search indexes. Enables get_file,
  // list_repos (prefix scan), and corpus_status (`_meta/corpus-status.json`).
  CORPUS?: R2Bucket;
  // Optional JSON array of repo names (or {"repos":["a","b"],"description":"..."}).
  // Preferred for list_repos when set; otherwise R2 prefixes are used when CORPUS is bound.
  CORPUS_REPOS?: string;
  // Model for the `ask` tool (chatCompletions). Falls back to a Workers AI default.
  GENERATION_MODEL?: string;
  ASSISTANT_SYSTEM_PROMPT?: string;
  // Soft default / hard ceiling for get_file (bytes). Defaults 64 KiB / 256 KiB.
  GET_FILE_MAX_BYTES?: string;
  GET_FILE_HARD_MAX_BYTES?: string;
}
