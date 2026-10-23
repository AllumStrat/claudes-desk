// Starts the audit server and the Astro page together, set up the way a live
// deploy is: the page on its own origin at /tools/seo-audit/, the API told to
// send sign-in and payment links back to that page.
//
//   npm run dev                      page calls /api, the dev server forwards it
//   npm run dev -- --cross-origin    page calls http://127.0.0.1:8787 directly (CORS)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.resolve(WEB, "..");
const PAGE_ORIGIN = "http://127.0.0.1:4321";
const PAGE = "/tools/seo-audit/";
const crossOrigin = process.argv.includes("--cross-origin");

const children = [];

function run(name, cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefix = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  };
  prefix(child.stdout, process.stdout);
  prefix(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`[${name}] stopped (${code ?? "signal"})`);
    for (const c of children) c.kill();
    process.exit(code ?? 0);
  });
  children.push(child);
}

run("api", process.execPath, ["--disable-warning=ExperimentalWarning", "src/node/server.js"], {
  cwd: TOOL,
  env: { ...process.env, APP_ORIGIN: process.env.APP_ORIGIN || PAGE_ORIGIN, APP_PAGE: process.env.APP_PAGE || PAGE },
});

// --ignore-lock keeps Astro in the foreground even when it thinks a coding
// agent started it, so this script owns both processes.
run("web", path.join(WEB, "node_modules/.bin/astro"), ["dev", "--ignore-lock"], {
  cwd: WEB,
  env: { ...process.env, ...(crossOrigin ? { PUBLIC_AUDIT_API: "http://127.0.0.1:8787" } : {}) },
});

console.log(`Open ${PAGE_ORIGIN}${PAGE}  (${crossOrigin ? "cross-origin API" : "API through the dev server"})`);
console.log("Sign-in links print below on the [api] lines.");

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => children.forEach((c) => c.kill(sig)));
