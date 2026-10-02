import { openDb } from "../db/index.js";
import { buildServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const db = openDb("data/tutor.db");
const app = buildServer({ db, dataDir: "data", appDir: "dist/app" });

// The tutor is for one person on one computer, so the server listens only on localhost.
await app.listen({ host: "127.0.0.1", port });
console.log(`\nThe tutor runs at http://localhost:${port}\nPress Ctrl+C to stop it.\n`);
