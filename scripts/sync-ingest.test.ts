import { describe, it, expect } from "vitest";
import {
  shouldRemapToTxt,
  isIngestible,
  isLikelyText,
  ingestObjectKey,
  isNativeIngestPath,
  isExcludedPath,
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
