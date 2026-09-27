import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Drives the real public/ask-widget.js against a minimal fake DOM and a fake fetch stream.
// Only the DOM and the network are faked; the widget's own parsing runs as shipped.
const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "..", "public", "ask-widget.js"), "utf8");

class FakeEl {
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, (ev: { preventDefault(): void }) => void> = {};
  private text = "";
  classList = { add: (_c: string) => {} };
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  addEventListener(name: string, fn: (ev: { preventDefault(): void }) => void) {
    this.listeners[name] = fn;
  }
}

const enc = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
      else ctrl.close();
    },
  });
}

async function run(chunks: string[], attrs: Record<string, string> = {}) {
  const parts: Record<string, FakeEl> = {
    ".vjask-form": new FakeEl(),
    ".vjask-input": new FakeEl(),
    ".vjask-btn": new FakeEl(),
    ".vjask-answer": new FakeEl(),
    ".vjask-sources": new FakeEl(),
    ".vjask-label": new FakeEl(),
  };
  const root = Object.assign(new FakeEl(), {
    innerHTML: "",
    querySelector: (sel: string) => parts[sel] ?? null,
  });
  const script = { getAttribute: (k: string) => attrs[k] ?? null };
  const doc = {
    currentScript: script,
    readyState: "complete",
    querySelector: () => root,
    createElement: () => new FakeEl(),
    createTextNode: (t: string) => Object.assign(new FakeEl(), { textContent: t }),
    addEventListener: () => {},
  };
  const fakeFetch = async () =>
    ({ ok: true, status: 200, body: streamOf(chunks) }) as unknown as Response;
  new Function("document", "window", "fetch", SRC)(doc, {}, fakeFetch);
  parts[".vjask-input"].value = "what is this?";
  parts[".vjask-form"].listeners["submit"]({ preventDefault() {} });
  for (let i = 0; i < 200 && parts[".vjask-btn"].disabled !== false; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(parts[".vjask-btn"].disabled).toBe(false);
  return {
    answer: parts[".vjask-answer"].textContent,
    sourcesShown: parts[".vjask-sources"].hidden === false,
  };
}

const EMPTY = "Nothing in the indexed corpus addresses that.";
const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const chunksEv = `event: chunks\ndata: ${JSON.stringify([{ item: { key: "repo/a.md" } }])}\n\n`;

describe("ask-widget stream handling", () => {
  it("shows a normal streamed answer with its sources", async () => {
    const r = await run([chunksEv, delta("Hel"), delta("lo"), "data: [DONE]\n\n"]);
    expect(r.answer).toBe("Hello");
    expect(r.sourcesShown).toBe(true);
  });

  it("a completed stream with no content and no sources shows the empty-corpus message", async () => {
    const r = await run(["data: [DONE]\n\n"]);
    expect(r.answer).toBe(EMPTY);
  });

  it("the empty-corpus message honors data-empty-text", async () => {
    const r = await run(["data: [DONE]\n\n"], { "data-empty-text": "No match." });
    expect(r.answer).toBe("No match.");
  });

  it("an error event mid-stream is shown as an error, not as an empty corpus", async () => {
    const r = await run([
      delta("Par"),
      `event: error\ndata: ${JSON.stringify({ error: { message: "upstream boom" } })}\n\n`,
    ]);
    expect(r.answer).toContain("something went wrong");
    expect(r.answer).toContain("upstream boom");
    expect(r.answer).not.toBe(EMPTY);
  });

  it("an error event with no content and no sources is an error, not an empty corpus", async () => {
    const r = await run([`event: error\ndata: ${JSON.stringify({ message: "search failed" })}\n\n`]);
    expect(r.answer).toContain("something went wrong");
    expect(r.answer).toContain("search failed");
    expect(r.answer).not.toBe(EMPTY);
  });

  it("an error event with an unparseable payload still shows a generic error", async () => {
    const r = await run(["event: error\ndata: not json\n\n"]);
    expect(r.answer).toContain("something went wrong");
    expect(r.answer).not.toBe(EMPTY);
  });

  it("a final event without a trailing blank line is not dropped", async () => {
    const r = await run([chunksEv, delta("Hel"), `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`]);
    expect(r.answer).toBe("Hello");
  });

  it("an error event without a trailing blank line is still surfaced", async () => {
    const r = await run([`event: error\ndata: ${JSON.stringify({ error: "late failure" })}`]);
    expect(r.answer).toContain("late failure");
    expect(r.answer).not.toBe(EMPTY);
  });

  it("joins a data payload split over several data: lines", async () => {
    const r = await run(['data: {"choices":[{"delta":\n', 'data: {"content":"multi"}}]}\n\n']);
    expect(r.answer).toBe("multi");
  });
});
