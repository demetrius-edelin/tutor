import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser app. "npm run build" writes it to dist/app, and the server serves it.
// "npm run dev:app" runs it with live reload and sends /api requests to the server on port 3000.
// The rule has a slash at the end. Without it, the rule also catches the module file /api.ts.
// The app is one file of about 500 kB. The browser loads it from the computer of the user, so the size limit
// of the warning is higher than the default of 500 kB.
export default defineConfig({
  root: "src/app",
  plugins: [react()],
  build: { outDir: "../../dist/app", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: { proxy: { "^/api/": "http://127.0.0.1:3000" } },
});
