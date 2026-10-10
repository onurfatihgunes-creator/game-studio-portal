import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": p("./src"), "server-only": p("./tests/stubs/server-only.ts") } },
  test: { include: ["tests/**/*.test.ts"] },
});
