import { defineConfig } from "vitest/config";

// The tests do not use the Vite settings of the browser app.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
