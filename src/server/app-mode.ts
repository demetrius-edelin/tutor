import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// The tutor from a download: Tutor.app on macOS, or "Start Tutor.bat" on Windows. These programs start the server with --app.
// Then the server keeps the data in a folder of the user, finds a free port, and opens the browser.

export const FIRST_PORT = 3000;
export const PORT_COUNT = 10;

// The folder for .env and data/. An update replaces the program folder, so the data must be in a different folder.
// TUTOR_HOME replaces the default folder.
export function userDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.TUTOR_HOME) return env.TUTOR_HOME;
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Tutor");
  if (platform === "win32") return win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), "Tutor");
  return posix.join(env.XDG_DATA_HOME ?? posix.join(home, ".local", "share"), "tutor");
}

// macOS runs an app from the download folder in a temporary copy that can disappear (App Translocation).
export const isTranslocated = (path = process.execPath) => path.includes("/AppTranslocation/");

// The command that opens an address in the default browser.
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // "start" is a command of cmd. Its first argument is the title of a window, so it is empty.
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

export function openBrowser(url: string): void {
  // BROWSER=none starts the tutor with no browser, for example for a test.
  if (process.env.BROWSER === "none") return;
  const [command, args] = browserCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => console.log(`Open ${url} in a browser.`));
  child.unref();
}

// True if a tutor answers on the port.
export async function isTutor(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return ((await response.json()) as { app?: unknown }).app === "tutor";
  } catch {
    return false;
  }
}

// The port of a tutor that runs already, or null. A second server must not start, because it uses the same database.
export async function runningTutor(first = FIRST_PORT, count = PORT_COUNT): Promise<number | null> {
  for (let port = first; port < first + count; port++) {
    if (await isTutor(port)) return port;
  }
  return null;
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolve(true)));
  });
}

// The first free port. Another program can use port 3000, so the tutor tries the next ports too.
export async function freePort(first = FIRST_PORT, count = PORT_COUNT): Promise<number> {
  for (let port = first; port < first + count; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`Other programs use the ports ${first} to ${first + count - 1}. Stop one of these programs, then start the tutor again.`);
}

// Tutor.app has no window, so on macOS an error message is also a dialog.
export function showError(message: string): void {
  console.error(message);
  if (process.platform === "darwin") {
    spawnSync("osascript", ["-e", "on run argv", "-e", 'display alert "Tutor" message (item 1 of argv) as critical', "-e", "end run", message]);
  }
}
