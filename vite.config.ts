import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser app. "npm run build" writes it to dist/app, and the server serves it.
// "npm run dev:app" runs it with live reload and sends /api requests to the server on port 3000.
export default defineConfig({
  root: "src/app",
  plugins: [react()],
  build: { outDir: "../../dist/app", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
