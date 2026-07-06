import { matchConsumer } from "./src/mcp";
import { describe, it, expect } from "vitest";
import worker from "./src/index";
import type { Env } from "./src/env";

const env = {
  ALLOWED_ORIGINS: "https://docs.example.com,https://www.docs.example.com",
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
