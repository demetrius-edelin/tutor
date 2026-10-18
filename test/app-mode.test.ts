import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import type { SettingsView } from "../src/server/api-types.js";
import { browserCommand, freePort, isTranslocated, runningTutor, userDataDir } from "../src/server/app-mode.js";
import { buildServer } from "../src/server/app.js";

const folder = () => mkdtempSync(join(tmpdir(), "tutor-app-mode-"));

// A port that the system gives, and that stays in use until the end of the test.
async function usedPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

describe("The tutor from a download", () => {
  it("keeps the data in a folder of the user", () => {
    expect(userDataDir("darwin", {}, "/Users/ana")).toBe("/Users/ana/Library/Application Support/Tutor");
    expect(userDataDir("win32", { LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local" }, "C:\\Users\\ana")).toBe("C:\\Users\\ana\\AppData\\Local\\Tutor");
    expect(userDataDir("win32", {}, "C:\\Users\\ana")).toBe("C:\\Users\\ana\\AppData\\Local\\Tutor");
    expect(userDataDir("linux", {}, "/home/ana")).toBe("/home/ana/.local/share/tutor");
    expect(userDataDir("linux", { XDG_DATA_HOME: "/data" }, "/home/ana")).toBe("/data/tutor");
    expect(userDataDir("darwin", { TUTOR_HOME: "/tmp/tutor" }, "/Users/ana")).toBe("/tmp/tutor");
  });

  it("finds an app in a temporary copy of macOS", () => {
    expect(isTranslocated("/private/var/folders/x/AppTranslocation/1234/d/Tutor.app/Contents/MacOS/node")).toBe(true);
    expect(isTranslocated("/Applications/Tutor.app/Contents/MacOS/node")).toBe(false);
  });

  it("opens the browser with the command of the system", () => {
    expect(browserCommand("http://localhost:3000/", "darwin")).toEqual(["open", ["http://localhost:3000/"]]);
    expect(browserCommand("http://localhost:3000/", "win32")).toEqual(["cmd", ["/c", "start", "", "http://localhost:3000/"]]);
    expect(browserCommand("http://localhost:3000/", "linux")).toEqual(["xdg-open", ["http://localhost:3000/"]]);
  });

  it("uses the next port if a program uses the first port", async () => {
    const { port, server } = await usedPort();
    try {
      expect(await freePort(port, 5)).toBeGreaterThan(port);
      await expect(freePort(port, 1)).rejects.toThrow(/Other programs use the ports/);
    } finally {
      server.close();
    }
  });

  it("finds a tutor that runs, and not another program", async () => {
    const { port: other, server } = await usedPort();
    const app = buildServer({ db: openDb(":memory:"), dataDir: folder() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      expect(await runningTutor(port, 1)).toBe(port);
      expect(await runningTutor(other, 1)).toBeNull();
    } finally {
      await app.close();
      server.close();
    }
  });
});

describe("Stop the tutor", () => {
  function start(onStop?: () => void) {
    const dir = folder();
    return buildServer({
      db: openDb(":memory:"),
      dataDir: join(dir, "data"),
      settings: { envFile: join(dir, ".env"), shellEnv: {} },
      ...(onStop ? { onStop } : {}),
    });
  }

  it("stops the tutor from a download, only with a JSON request", async () => {
    let stops = 0;
    const app = start(() => stops++);
    expect(((await app.inject({ method: "GET", url: "/api/settings" })).json() as SettingsView).canStop).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/stop", payload: "x", headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    expect(stops).toBe(0);
    const response = await app.inject({ method: "POST", url: "/api/stop", payload: {} });
    expect(response.json()).toEqual({ ok: true });
    expect(stops).toBe(1);
    await app.close();
  });

  it("has no stop route for npm start", async () => {
    const app = start();
    expect(((await app.inject({ method: "GET", url: "/api/settings" })).json() as SettingsView).canStop).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/stop", payload: {} })).statusCode).toBe(404);
    await app.close();
  });
});
