import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

// Build the downloads of the tutor for users who do not use a terminal:
//   release/Tutor-<version>-macos.zip         Tutor.app, for Macs with Apple silicon and with Intel
//   release/Tutor-<version>-windows-x64.zip   a folder with "Start Tutor.bat"
// Each download has its own Node.js program and the production packages, so the user needs no Node.js and no npm.
// The script runs on macOS, because the Mac app needs clang, lipo, iconutil, and ditto.
//
// Options: --only macos, or --only windows.
// The signature and the notarization of the Mac app are optional. See docs/release.md.
//   MACOS_SIGN_IDENTITY: for example "Developer ID Application: Name (TEAMID)".
//   APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID: the Apple account for notarytool.

const NODE_VERSION = "24.22.1";
const ROOT = resolve(import.meta.dirname, "..");
const FILES = join(ROOT, "scripts", "package");
const RELEASE = join(ROOT, "release");
const WORK = join(RELEASE, "work");
const CACHE = join(RELEASE, "cache");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const BUNDLE_ID = "io.github.demetrius-edelin.tutor";

// Run a command. A secret command does not show its arguments, because they contain a password.
function run(command: string, args: string[], options: { cwd?: string; secret?: boolean } = {}): string {
  console.log(`$ ${command} ${options.secret ? "(arguments hidden)" : args.join(" ")}`);
  return execFileSync(command, args, { cwd: options.cwd ?? ROOT, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Build the browser app and the server. The server becomes one file, and the packages stay in node_modules.
async function buildApp(): Promise<void> {
  run("npx", ["vite", "build"]);
  await build({
    entryPoints: [join(ROOT, "src", "server", "main.ts")],
    outfile: join(ROOT, "dist", "server", "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    logLevel: "warning",
  });
}

// Download an archive of Node.js once, and check it against the checksums of nodejs.org.
async function nodeArchive(name: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${name}`))
    ?.split(" ")[0];
  if (!expected) throw new Error(`SHASUMS256.txt of Node.js ${NODE_VERSION} has no ${name}.`);
  const file = join(CACHE, name);
  if (!existsSync(file) || sha256(file) !== expected) {
    console.log(`Downloading ${base}/${name}`);
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) throw new Error(`The download of ${name} failed: ${response.status}.`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    if (sha256(file) !== expected) throw new Error(`The checksum of ${name} is not correct.`);
  }
  return file;
}

// Get the program and the license from an archive of Node.js. bsdtar of macOS also reads zip files.
async function extractNode(name: string, program: string, into: string): Promise<{ program: string; license: string }> {
  const archive = await nodeArchive(name);
  const folder = name.replace(/\.(tar\.gz|zip)$/, "");
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  run("tar", ["-xf", archive, "-C", into, `${folder}/${program}`, `${folder}/LICENSE`]);
  return { program: join(into, folder, program), license: join(into, folder, "LICENSE") };
}

// Install the production packages for one system. npm selects the native packages of that system.
function installPackages(into: string, os: string, cpu: string): string {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) cpSync(join(ROOT, file), join(into, file));
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", `--os=${os}`, `--cpu=${cpu}`, "--no-audit", "--no-fund"], { cwd: into });
  return join(into, "node_modules");
}

// Copy the packages that only one tree has, for example the native package of the canvas for Intel Macs.
function addMissingPackages(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    if (name.startsWith(".")) continue;
    const source = join(from, name);
    if (name.startsWith("@")) {
      for (const inner of readdirSync(source)) {
        if (!existsSync(join(to, name, inner))) cpSync(join(source, inner), join(to, name, inner), { recursive: true });
      }
    } else if (!existsSync(join(to, name))) {
      cpSync(source, join(to, name), { recursive: true });
    }
  }
}

function walk(folder: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

// Remove the files that the program does not use: source maps, TypeScript files, and the native files of other systems.
// Node.js does not run TypeScript files in node_modules, so they are safe to remove.
function prune(modules: string, prebuilds: string[]): void {
  rmSync(join(modules, ".bin"), { recursive: true, force: true });
  const sqlite = join(modules, "better-sqlite3");
  for (const part of ["deps", "src", "binding.gyp"]) rmSync(join(sqlite, part), { recursive: true, force: true });
  for (const file of readdirSync(join(sqlite, "prebuilds"))) {
    if (!prebuilds.includes(file)) rmSync(join(sqlite, "prebuilds", file));
  }
  walk(modules, (file) => {
    if (/\.(map|ts|mts|cts)$/.test(file)) rmSync(file);
  });
}

// The "app" folder: the built app, the server, the packages, and the example configuration.
function appFolder(into: string, modules: string): void {
  mkdirSync(into, { recursive: true });
  cpSync(join(ROOT, "dist", "app"), join(into, "dist", "app"), { recursive: true });
  cpSync(join(ROOT, "dist", "server"), join(into, "dist", "server"), { recursive: true });
  cpSync(modules, join(into, "node_modules"), { recursive: true });
  for (const file of [".env.example", "LICENSE"]) cpSync(join(ROOT, file), join(into, file));
  const manifest = { name: "tutor", version: VERSION, private: true, license: "MIT", type: "module" };
  writeFileSync(join(into, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// The icon of the Mac app, from scripts/package/icon.svg. The canvas package of the PDF reader draws it.
async function macIcon(into: string): Promise<void> {
  const { createCanvas, Image } = await import("@napi-rs/canvas");
  const image = new Image();
  image.src = readFileSync(join(FILES, "icon.svg"));
  const iconset = join(WORK, "Tutor.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale;
      const canvas = createCanvas(pixels, pixels);
      canvas.getContext("2d").drawImage(image, 0, 0, pixels, pixels);
      writeFileSync(join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`), canvas.toBuffer("image/png"));
    }
  }
  run("iconutil", ["-c", "icns", iconset, "-o", into]);
}

const plist = (entries: Record<string, string | boolean>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(entries)
  .map(([key, value]) => `  <key>${key}</key>\n  ${typeof value === "boolean" ? `<${value}/>` : `<string>${value}</string>`}`)
  .join("\n")}
</dict>
</plist>
`;

// Tutor.app: the launcher, Node.js for both kinds of Mac in one file, and the app folder.
async function macApp(): Promise<string> {
  const app = join(WORK, "macos", "Tutor.app");
  rmSync(join(WORK, "macos"), { recursive: true, force: true });
  const contents = join(app, "Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });

  const arm = await extractNode(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`, "bin/node", join(WORK, "node-darwin-arm64"));
  const intel = await extractNode(`node-v${NODE_VERSION}-darwin-x64.tar.gz`, "bin/node", join(WORK, "node-darwin-x64"));
  run("lipo", ["-create", arm.program, intel.program, "-output", join(contents, "MacOS", "node")]);
  cpSync(arm.license, join(contents, "Resources", "node-LICENSE"));
  run("clang", ["-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-O2", "-Wall", "-o", join(contents, "MacOS", "Tutor"), join(FILES, "launcher.c")]);
  await macIcon(join(contents, "Resources", "Tutor.icns"));
  writeFileSync(
    join(contents, "Info.plist"),
    plist({
      CFBundleDevelopmentRegion: "en",
      CFBundleDisplayName: "Tutor",
      CFBundleExecutable: "Tutor",
      CFBundleIconFile: "Tutor",
      CFBundleIdentifier: BUNDLE_ID,
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleName: "Tutor",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: VERSION,
      CFBundleVersion: VERSION,
      // The app has no window and no Dock icon. The launcher starts the server and ends.
      LSUIElement: true,
      NSHumanReadableCopyright: "MIT License",
    }),
  );

  const modules = installPackages(join(WORK, "packages-darwin-arm64"), "darwin", "arm64");
  addMissingPackages(installPackages(join(WORK, "packages-darwin-x64"), "darwin", "x64"), modules);
  prune(modules, ["darwin-arm64.node", "darwin-x64.node"]);
  appFolder(join(contents, "Resources", "app"), modules);
  return app;
}

// A Mach-O file starts with one of these numbers. 0xcafebabe is a file for more than one processor.
const MACH_O = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe]);

function isMachO(file: string): boolean {
  if (file.endsWith(".class") || statSync(file).size < 4) return false;
  const buffer = Buffer.alloc(4);
  const handle = openSync(file, "r");
  readSync(handle, buffer, 0, 4, 0);
  closeSync(handle);
  return MACH_O.has(buffer.readUInt32BE(0));
}

// Sign the inner programs first, then the app. Node.js needs its entitlements, for example for the JIT compiler of V8.
function signMacApp(app: string, identity: string): void {
  const codesign = (path: string, entitlements?: string) =>
    run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, ...(entitlements ? ["--entitlements", entitlements] : []), path]);
  walk(join(app, "Contents", "Resources"), (file) => {
    if (isMachO(file)) codesign(file);
  });
  codesign(join(app, "Contents", "MacOS", "node"), join(FILES, "entitlements.plist"));
  codesign(app);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
}

// Send the app to the notary service of Apple, then attach the ticket to the app. Then Gatekeeper needs no network.
function notarizeMacApp(app: string): void {
  const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_PASSWORD || !APPLE_TEAM_ID) {
    console.log("No notarization: set APPLE_ID, APPLE_APP_PASSWORD, and APPLE_TEAM_ID.");
    return;
  }
  const upload = join(WORK, "notarize.zip");
  run("ditto", ["-c", "-k", "--keepParent", app, upload]);
  const account = ["--apple-id", APPLE_ID, "--password", APPLE_APP_PASSWORD, "--team-id", APPLE_TEAM_ID];
  const result = JSON.parse(run("xcrun", ["notarytool", "submit", upload, ...account, "--wait", "--output-format", "json"], { secret: true })) as {
    id: string;
    status: string;
  };
  if (result.status !== "Accepted") {
    console.log(run("xcrun", ["notarytool", "log", result.id, ...account], { secret: true }));
    throw new Error(`The notarization failed with the status "${result.status}".`);
  }
  run("xcrun", ["stapler", "staple", app]);
  rmSync(upload);
}

// Start the server of the app with no browser, then ask for the health, the app page, and the settings. Then stop it.
async function smokeTest(node: string, appDir: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "tutor-smoke-"));
  const port = String(39000 + Math.floor(Math.random() * 900));
  const server = spawn(node, [join(appDir, "dist", "server", "main.js"), "--app"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TUTOR_HOME: home, PORT: port, BROWSER: "none" },
    stdio: "inherit",
  });
  const exited = new Promise<number | null>((done) => server.on("exit", done));
  try {
    const url = `http://127.0.0.1:${port}`;
    let health: unknown = null;
    for (let attempt = 0; attempt < 60 && health === null; attempt++) {
      await new Promise((done) => setTimeout(done, 250));
      health = await fetch(`${url}/api/health`).then((response) => response.json()).catch(() => null);
    }
    if ((health as { app?: string } | null)?.app !== "tutor") throw new Error("The server of the app did not start.");
    const page = await (await fetch(`${url}/`)).text();
    if (!page.includes("<div id=")) throw new Error("The server of the app did not serve the browser app.");
    const settings = (await (await fetch(`${url}/api/settings`)).json()) as { canStop?: boolean };
    if (!settings.canStop) throw new Error("The settings of the app do not offer the stop button.");
    await fetch(`${url}/api/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if ((await exited) !== 0) throw new Error("The server of the app did not stop correctly.");
    // The packages with native files must load: SQLite and the canvas of the PDF reader.
    run(node, ["-e", "require('better-sqlite3'); require('@napi-rs/canvas'); console.log('The native packages load.')"], { cwd: appDir });
    console.log("Smoke test passed.");
  } finally {
    server.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

// The Windows folder: "Start Tutor.bat" and the app folder with node.exe.
async function windowsFolder(): Promise<string> {
  const folder = join(WORK, "windows", "Tutor");
  rmSync(join(WORK, "windows"), { recursive: true, force: true });
  mkdirSync(join(folder, "app"), { recursive: true });
  const node = await extractNode(`node-v${NODE_VERSION}-win-x64.zip`, "node.exe", join(WORK, "node-win-x64"));
  cpSync(node.program, join(folder, "app", "node.exe"));
  cpSync(node.license, join(folder, "app", "node-LICENSE"));
  cpSync(join(FILES, "Start Tutor.bat"), join(folder, "Start Tutor.bat"));
  const modules = installPackages(join(WORK, "packages-win32-x64"), "win32", "x64");
  prune(modules, ["win32-x64.node"]);
  appFolder(join(folder, "app"), modules);
  return folder;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Run this script on macOS. The Mac app needs clang, lipo, iconutil, and ditto.");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  if (only !== null && only !== "macos" && only !== "windows") throw new Error('Use --only macos or --only windows.');
  mkdirSync(RELEASE, { recursive: true });
  await buildApp();

  if (only !== "windows") {
    const app = await macApp();
    const identity = process.env.MACOS_SIGN_IDENTITY;
    if (identity) {
      signMacApp(app, identity);
      notarizeMacApp(app);
    } else {
      console.log("No signature: set MACOS_SIGN_IDENTITY to sign the Mac app. Users then see a warning at the first start.");
    }
    if (process.arch === "arm64" || process.arch === "x64") await smokeTest(join(app, "Contents", "MacOS", "node"), join(app, "Contents", "Resources", "app"));
    const zip = join(RELEASE, `Tutor-${VERSION}-macos.zip`);
    rmSync(zip, { force: true });
    run("ditto", ["-c", "-k", "--keepParent", app, zip]);
    console.log(`Wrote ${zip}`);
  }

  if (only !== "macos") {
    const folder = await windowsFolder();
    const zip = join(RELEASE, `Tutor-${VERSION}-windows-x64.zip`);
    rmSync(zip, { force: true });
    run("zip", ["-r", "-X", "-q", zip, "Tutor"], { cwd: join(folder, "..") });
    console.log(`Wrote ${zip}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
