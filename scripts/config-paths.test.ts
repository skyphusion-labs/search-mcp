import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultRepoRoot,
  resolveTargetsPath,
} from "./config-paths.mjs";

describe("config-paths", () => {
  it("prefers SEARCH_MCP_TARGETS", () => {
    const prev = process.env.SEARCH_MCP_TARGETS;
    process.env.SEARCH_MCP_TARGETS = "/tmp/custom-targets.json";
    try {
      expect(resolveTargetsPath("/pkg/scripts")).toBe("/tmp/custom-targets.json");
    } finally {
      if (prev === undefined) delete process.env.SEARCH_MCP_TARGETS;
      else process.env.SEARCH_MCP_TARGETS = prev;
    }
  });

  it("finds targets.json in cwd before scripts dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "search-mcp-"));
    const cwd = join(dir, "project");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "targets.json"), "{}");
    const prev = process.cwd();
    process.chdir(cwd);
    try {
      const found = resolveTargetsPath(join(dir, "pkg", "scripts"));
      expect(found).toBeTruthy();
      expect(realpathSync(found!)).toBe(
        realpathSync(resolve(cwd, "targets.json")),
      );
    } finally {
      process.chdir(prev);
    }
  });

  it("defaults repo root to cwd when targets live in cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "corpus-"));
    const targets = join(cwd, "targets.json");
    expect(defaultRepoRoot("/pkg/scripts", targets)).toBe(cwd);
  });

  it("defaults repo root to dev clone parent when targets are in scripts/", () => {
    const scriptsDir = "/repo/scripts";
    const targets = join(scriptsDir, "targets.json");
    expect(defaultRepoRoot(scriptsDir, targets)).toBe(
      resolve(scriptsDir, "..", ".."),
    );
  });
});
