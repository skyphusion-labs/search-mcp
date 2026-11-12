import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workersStub = fileURLToPath(new URL("./test/cloudflare-workers-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: "cloudflare:workers", replacement: workersStub }],
  },
  test: {
    environment: "node",
    include: ["*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
    },
  },
});
