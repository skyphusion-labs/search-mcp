import { WorkerEntrypoint } from "cloudflare:workers";
import type { AiSearchChunk, AiSearchMessage, AiSearchOptions, Env } from "./env";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a documentation assistant.",
  "Answer only from the retrieved context. If the context does not contain the answer,",
  "say so plainly and suggest where the user might look next; never invent APIs,",
  "flags, prices, or behavior. Prefer concrete file and command references. Be concise.",
].join(" ");

const BLOG_ORIGINS = new Set(["https://skyphusion.net", "https://www.skyphusion.net"]);

const BLOG_SYSTEM_PROMPT = [
  "You are the search assistant for skyphusion.net, Conrad Rockenhaus's engineering blog.",
  "Answer only from the retrieved context (blog posts, READMEs, and public repo docs in the corpus).",
  "Prefer linking ideas to specific posts or projects when the context names them.",
  "If the context does not contain the answer, say so plainly; never invent posts, URLs, or behavior.",
  "Be concise and write in plain technical prose.",
].join(" ");

/**
 * Origin -> system prompt, from configuration rather than code.
 *
 * This Worker used to carry a hardcoded origin Set and an if/else to pick a
 * prompt, which meant every new site served by the same deployment needed a
 * code change and a redeploy. ORIGIN_PROFILES is a JSON object in vars mapping
 * an exact origin to the system prompt for that site, so adding a site is
 * configuration.
 *
 * Precedence: ORIGIN_PROFILES, then the legacy blog special-case (kept so
 * existing deployments do not change behaviour), then the default.
 *
 * Parse failures are logged and ignored rather than thrown: a malformed var
 * should degrade to the default prompt, not take /ask down.
 */
function originProfiles(env: Env): Record<string, string> {
  if (!env.ORIGIN_PROFILES) return {};
  try {
    const parsed: unknown = JSON.parse(env.ORIGIN_PROFILES);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.log("ORIGIN_PROFILES is not a JSON object; ignoring");
      return {};
    }
    const out: Record<string, string> = {};
    for (const [origin, prompt] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof prompt === "string" && prompt.trim()) out[origin] = prompt.trim();
    }
    return out;
  } catch (err) {
    console.log("ORIGIN_PROFILES parse failed; ignoring", String(err));
    return {};
  }
}

/** The system prompt for a request origin. Exported for tests. */
export function systemPromptFor(env: Env, origin: string): string {
  const profile = originProfiles(env)[origin];
  if (profile) return profile;
  if (BLOG_ORIGINS.has(origin)) {
    return env.BLOG_ASSISTANT_SYSTEM_PROMPT?.trim() || BLOG_SYSTEM_PROMPT;
  }
  return env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
}

const MAX_QUESTION_LEN = 2000;

// One bucket for every service-binding caller. An RPC call has no client IP,
// and the key is not taken from the caller, so a binding cannot pick a bucket.
const SEARCH_RPC_LIMIT_KEY = "ask:rpc";

// Retrieval options /ask passes to chatCompletions. The RPC method passes the
// same options to SEARCH.search and does not generate.
function askAiSearchOptions(): AiSearchOptions {
  return {
    retrieval: { retrieval_type: "hybrid", max_num_results: 6 },
    query_rewrite: { enabled: true },
  };
}

function questionForRpc(question: unknown): string {
  if (typeof question !== "string") throw new Error("empty_question");
  const trimmed = question.trim();
  if (!trimmed) throw new Error("empty_question");
  if (trimmed.length > MAX_QUESTION_LEN) throw new Error("question_too_long");
  return trimmed;
}

const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface AskBody {
  question?: string;
  turnstileToken?: string;
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    console.log("TURNSTILE_SECRET unset; skipping Turnstile verification");
    return true;
  }
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.log("Turnstile verify failed", String(err));
    return false;
  }
}

async function handleAsk(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!cors["Access-Control-Allow-Origin"]) {
    return json({ error: "origin_not_allowed" }, 403, cors);
  }

  let body: AskBody;
  try {
    body = (await request.json()) as AskBody;
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }

  const question = (body.question ?? "").trim();
  if (!question) return json({ error: "empty_question" }, 400, cors);
  if (question.length > MAX_QUESTION_LEN) {
    return json({ error: "question_too_long" }, 413, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (!(await verifyTurnstile(env, body.turnstileToken, ip))) {
    return json({ error: "turnstile_failed" }, 403, cors);
  }

  const { success } = await env.ASK_LIMITER.limit({ key: `ask:${ip}` });
  if (!success) return json({ error: "rate_limited" }, 429, cors);

  const origin = request.headers.get("Origin") ?? "";
  const systemPrompt = systemPromptFor(env, origin);
  const messages: AiSearchMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ];

  let result: ReadableStream<Uint8Array> | unknown;
  try {
    result = await env.SEARCH.chatCompletions({
      messages,
      model: env.GENERATION_MODEL,
      stream: true,
      ai_search_options: askAiSearchOptions(),
    });
  } catch (err) {
    console.log("chatCompletions error", String(err));
    return json({ error: "search_unavailable" }, 502, cors);
  }

  if (!(result instanceof ReadableStream)) {
    return json({ error: "unexpected_response" }, 502, cors);
  }

  return new Response(result, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      ...cors,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "search-mcp-query" }, 200);
    }

    if (url.pathname === "/ask" && request.method === "POST") {
      return handleAsk(request, env);
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/**
 * Retrieval for a service binding. This class is a named entrypoint, not a
 * route: public fetch stays on the default export above. A caller selects it
 * with wrangler `entrypoint = "SearchEntrypoint"` on its service binding.
 * There is no browser request here, so Origin and Turnstile do not apply.
 * ASK_LIMITER still applies, on SEARCH_RPC_LIMIT_KEY.
 *
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints
 */
export class SearchEntrypoint extends WorkerEntrypoint<Env> {
  async search(question: string): Promise<{ chunks: AiSearchChunk[] }> {
    const q = questionForRpc(question);
    const { success } = await this.env.ASK_LIMITER.limit({ key: SEARCH_RPC_LIMIT_KEY });
    if (!success) throw new Error("rate_limited");

    try {
      const res = await this.env.SEARCH.search({
        query: q,
        ai_search_options: askAiSearchOptions(),
      });
      if (!Array.isArray(res?.chunks)) {
        console.log("search rpc error", "chunks missing");
        throw new Error("search_unavailable");
      }
      return { chunks: res.chunks };
    } catch (err) {
      if (err instanceof Error && err.message === "search_unavailable") throw err;
      console.log("search rpc error", String(err));
      throw new Error("search_unavailable");
    }
  }
}
