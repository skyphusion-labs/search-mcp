import { describe, it, expect } from "vitest";
import {
  shouldRemapToTxt,
  isIngestible,
  isLikelyText,
  ingestObjectKey,
  isNativeIngestPath,
  isExcludedPath,
  isIncludedPath,
} from "./sync-ingest.mjs";

const text = Buffer.from("#!/bin/bash\necho hello\n");
const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]);

describe("shouldRemapToTxt", () => {
  it("remaps TS and extensionless infra text", () => {
    expect(shouldRemapToTxt("src/index.ts", text)).toBe(true);
    expect(shouldRemapToTxt("Dockerfile", text)).toBe(true);
  });

  it("leaves native extensions alone", () => {
    expect(shouldRemapToTxt("README.md", text)).toBe(false);
  });

  it("does not remap unknown binary", () => {
    expect(isIngestible("image.dat", binary)).toBe(false);
  });
});

describe("ingestObjectKey", () => {
  it("appends .txt when remapped", () => {
    expect(ingestObjectKey("my-repo", "Dockerfile", true)).toBe("my-repo/Dockerfile.txt");
  });
});

describe("isExcludedPath", () => {
  it("excludes configured prefixes", () => {
    const prefixes = ["notes/private/", "README.secret"];
    expect(isExcludedPath("notes/private/foo.md", prefixes)).toBe(true);
    expect(isExcludedPath("notes/public/foo.md", prefixes)).toBe(false);
  });
});

describe("isIncludedPath (corpus allowlist)", () => {
  // POSITIVE CONTROL. An allowlist that rejects everything would make every
  // negative assertion below pass for free.
  it("admits a path inside an allowed subtree", () => {
    expect(isIncludedPath("_corpus/doc/p001.txt", ["_corpus/"])).toBe(true);
  });

  it("refuses a path outside every allowed prefix", () => {
    expect(isIncludedPath("_data/faq.json", ["_corpus/"])).toBe(false);
    expect(isIncludedPath("index.html", ["_corpus/"])).toBe(false);
  });

  it("is fail-closed for a NEW top-level file", () => {
    // This is the whole reason the allowlist exists. A denylist would admit
    // this file silently; an allowlist refuses it until someone opts it in.
    expect(isIncludedPath("brand-new-accidental-file.json", ["_corpus/"])).toBe(false);
  });

  it("treats a bare name as that file or its subtree", () => {
    expect(isIncludedPath("docs", ["docs"])).toBe(true);
    expect(isIncludedPath("docs/guide.md", ["docs"])).toBe(true);
    expect(isIncludedPath("docsite/guide.md", ["docs"])).toBe(false);
  });

  it("admits everything when no allowlist is configured (backwards compatible)", () => {
    expect(isIncludedPath("anything/at/all.md", [])).toBe(true);
    expect(isIncludedPath("anything/at/all.md", undefined)).toBe(true);
  });

  it("supports several allowed prefixes", () => {
    const allow = ["_corpus/", "docs/"];
    expect(isIncludedPath("docs/a.md", allow)).toBe(true);
    expect(isIncludedPath("_corpus/a.txt", allow)).toBe(true);
    expect(isIncludedPath("src/a.ts", allow)).toBe(false);
  });
});
