#!/usr/bin/env node
// Takes a picture of the interface preview (npm run ui) in headless Chrome,
// optionally after running some JavaScript in the window first: open a
// host, click a button, open a menu. For looking at the interface without
// building the app, by hand or from a script.
//
//   node scripts/ui-shot.mjs out.png
//   node scripts/ui-shot.mjs out.png --query "account=free&os=windows"
//   node scripts/ui-shot.mjs out.png --eval "__myssh.openHost('h-web1')" --wait 2500
//   node scripts/ui-shot.mjs out.png --eval steps.js --size 1440x900 --scale 2
//   node scripts/ui-shot.mjs out.png --eval artwork.js --size 1024x1024 --transparent
//
// --eval takes JavaScript or a file of it; it runs in the window as the body
// of an async function, with `__myssh` (the app's stores and actions),
// `sleep(ms)` and `click(selector)` at hand, and what it returns is printed.
// The preview has to be running: npm run ui (port 1430, or --port).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function options(argv) {
  const out = { file: null, query: "", evaluate: null, wait: 1500, size: "1280x800", scale: 1, port: 1430, transparent: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--query") out.query = next().replace(/^\?/, "");
    else if (arg === "--eval") out.evaluate = next();
    else if (arg === "--wait") out.wait = Number(next());
    else if (arg === "--size") out.size = next();
    else if (arg === "--scale") out.scale = Number(next());
    else if (arg === "--port") out.port = Number(next());
    else if (arg === "--transparent") out.transparent = true;
    else if (!out.file) out.file = arg;
    else throw new Error(`what is ${arg}?`);
  }
  if (!out.file) throw new Error("say where to put the picture: node scripts/ui-shot.mjs out.png");
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, test, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`);
    await sleep(100);
  }
}

const opts = options(process.argv.slice(2));
const base = `http://localhost:${opts.port}/preview.html`;
const reachable = await fetch(base).then((r) => r.ok, () => false);
if (!reachable) {
  console.error(`The preview is not running at ${base}: start it with npm run ui`);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "myssh-ui-shot-"));
const [width, height] = opts.size.split("x").map(Number);
const chrome = spawn(CHROME, [
  "--headless=new",
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  `--window-size=${width},${height}`,
  "about:blank",
], { stdio: "ignore" });

try {
  const portFile = join(profile, "DevToolsActivePort");
  const port = await waitFor("Chrome", () => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0]);
  const pages = await waitFor("a page", () =>
    fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((list) => list.find((p) => p.type === "page"), () => null),
  );
  const socket = new WebSocket(pages.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: opts.scale, mobile: false });
  // Each picture starts from the same place: the panel hidden, settings as new.
  const query = new URLSearchParams(opts.query);
  if (!query.has("panel")) query.set("panel", "false");
  await send("Page.navigate", { url: `${base}?${query}` });
  await waitFor("the app", async () => {
    const { result } = await send("Runtime.evaluate", { expression: "Boolean(window.__myssh && document.querySelector('#root > *'))" });
    return result.value;
  });
  await sleep(600);

  if (opts.evaluate) {
    const code = existsSync(opts.evaluate) ? readFileSync(opts.evaluate, "utf8") : opts.evaluate;
    const wrapped = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const click = (selector) => { const el = document.querySelector(selector); if (!el) throw new Error("nothing matches " + selector); el.click(); };
      const __myssh = window.__myssh;
      ${/^\s*(return|const|let|await|for|if|\{)/.test(code) || code.includes("\n") ? code : `return (${code});`}
    })()`;
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    if (result.value !== undefined) console.log(JSON.stringify(result.value, null, 2));
  }
  await sleep(opts.wait);

  if (opts.transparent) await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(opts.file, Buffer.from(data, "base64"));
  for (const error of errors) console.error(`window: ${error}`);
  console.log(opts.file);
  socket.close();
} finally {
  chrome.kill();
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
