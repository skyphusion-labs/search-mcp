import type { Env, AiSearchMessage } from "./env";

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

const MAX_QUESTION_LEN = 2000;
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
  const systemPrompt = BLOG_ORIGINS.has(origin)
    ? env.BLOG_ASSISTANT_SYSTEM_PROMPT?.trim() || BLOG_SYSTEM_PROMPT
    : env.ASSISTANT_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT;
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
      ai_search_options: {
        retrieval: { retrieval_type: "hybrid", max_num_results: 6 },
        query_rewrite: { enabled: true },
      },
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
