import { describe, it, expect } from "vitest";
import worker from "./src/index";
import type { Env } from "./src/env";

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
