// Drives the built Agentree desktop app for agents: launches Electron with
// disposable homes and a DevTools port, then runs commands read line by line
// from stdin (piped or interactive). Talks plain CDP over Node's WebSocket,
// so nothing beyond the repo's own dependencies is needed.
//
//   printf 'launch\nday 2026-10-01\nss day\nquit\n' | node .claude/skills/run-desktop/driver.mjs
//
// See SKILL.md for the commands.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHOTS = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), "agentree-shots");
const PORT = Number(process.env.AGENTREE_DRIVER_PORT || 9333);

let child = null;
let ws = null;
let mode = null;
let seq = 0;
const waiting = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params = {}) {
  if (!ws) throw new Error("launch first");
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(expr, what, ms = 20_000) {
  for (let t = 0; t < ms; t += 200) {
    if (await evaluate(expr).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Newest source file vs the renderer build: a stale build shows yesterday's UI. */
function staleBuild() {
  const built = path.join(REPO, "dist", "index.html");
  if (!fs.existsSync(built) || !fs.existsSync(path.join(REPO, "dist-electron", "main.cjs"))) return "missing";
  const at = fs.statSync(built).mtimeMs;
  const newer = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).some((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? newer(p) : /\.(tsx?|css)$/.test(e.name) && fs.statSync(p).mtimeMs > at;
    });
  return ["src", "shared", "electron"].some((d) => newer(path.join(REPO, d))) ? "stale" : null;
}

const NEED_ARG = (a, usage) => {
  if (!a) throw new Error(`usage: ${usage}`);
};

const COMMANDS = {
  /** launch [fixtures|real] — fixtures (default): the committed test fixtures; real: your stores, read-only. */
  async launch(arg) {
    if (child) return "already launched";
    mode = arg === "real" ? "real" : "fixtures";
    const build = staleBuild();
    if (build === "missing") throw new Error("no build — run `npm run build` first");
    if (build === "stale") console.log("WARNING: sources are newer than dist/ — run `npm run build` to see your changes");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-drive-"));
    const env = { ...process.env, AGENTREE_HOME: path.join(tmp, "agentree"), AGENTREE_NO_UPDATE_CHECK: "1" };
    // Shells started from VS Code inherit this, and it turns electron.exe into plain Node.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.AGENTVIEW_DEV_URL;
    if (mode === "fixtures") {
      env.CLAUDE_CONFIG_DIR = path.join(REPO, "test", "fixtures", "claude", "2.1");
      env.CODEX_HOME = path.join(REPO, "test", "fixtures", "codex", "0.162", "home");
      env.COPILOT_HOME = path.join(tmp, "copilot");
    } else {
      for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "COPILOT_HOME"]) delete env[v];
    }
    const electron = createRequire(path.join(REPO, "package.json"))("electron");
    child = spawn(electron, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(tmp, "profile")}`, "."], {
      cwd: REPO,
      env,
      stdio: "ignore",
    });
    child.on("exit", () => {
      child = null;
      ws = null;
    });

    let target;
    for (let i = 0; i < 100 && !target; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
      } catch {
        /* not listening yet */
      }
    }
    if (!target) throw new Error(`no page on port ${PORT} (another app on it? set AGENTREE_DRIVER_PORT)`);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      const done = m.id && waiting.get(m.id);
      if (done) {
        waiting.delete(m.id);
        done(m);
      }
    });
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
    // Ready: the welcome screen has scanned (the count replaces "scanning…").
    await waitFor(`/\\d+ conversations/.test(document.body.innerText)`, "the conversation list", 60_000);
    return `launched (${mode}); AGENTREE_HOME=${env.AGENTREE_HOME}`;
  },

  /** ss [name] — screenshot of the window. */
  async ss(name) {
    await sleep(300); // let React and the SVG settle
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `${name || `ss-${Date.now()}`}.png`);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    return `screenshot: ${f}`;
  },

  /** click <css> — DOM click on the first match; SVG elements get a dispatched click event. */
  async click(sel) {
    NEED_ARG(sel, "click <css selector>");
    guard(await evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`));
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return "NOT_FOUND";
      if (el.click) el.click(); else el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return "OK";
    })()`);
  },

  /** click-text <text> — click the first button or link whose text contains <text>. */
  async "click-text"(text) {
    NEED_ARG(text, "click-text <text>");
    guard(text);
    return evaluate(`(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const t = ${JSON.stringify(text)};
      const el = els.find((e) => e.textContent.trim() === t) ?? els.find((e) => e.textContent.includes(t));
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK: " + el.tagName + " " + el.className;
    })()`);
  },

  /** key <Key> — press a key: ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Enter, Escape, Tab… */
  async key(k) {
    NEED_ARG(k, "key <Key>");
    const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Tab: 9 };
    for (const type of ["keyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: codes[k] });
    }
    return "OK";
  },

  /** type <text> — type into the focused element. */
  async type(text) {
    await send("Input.insertText", { text });
    return "OK";
  },

  /** fill <css> <value> — set a React-controlled input's value (the search box, the day's date). */
  async fill(arg) {
    const [sel, ...rest] = arg.split(" ");
    NEED_ARG(sel && rest.length, "fill <css selector> <value>");
    return evaluate(`(() => {
      const i = document.querySelector(${JSON.stringify(sel)});
      if (!i) return "NOT_FOUND";
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(rest.join(" "))});
      i.dispatchEvent(new Event("input", { bubbles: true }));
      return "OK: " + i.value;
    })()`);
  },

  /** wait <css> — until the selector matches (20 s). */
  async wait(sel) {
    NEED_ARG(sel, "wait <css selector>");
    await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, sel);
    return `found: ${sel}`;
  },

  /** eval <js> — evaluate in the page, print the JSON result. */
  async eval(expr) {
    return JSON.stringify(await evaluate(expr));
  },

  /** text [css] — innerText of the selector (default: the page). */
  async text(sel) {
    return evaluate(`(${JSON.stringify(sel || null)} ? document.querySelector(${JSON.stringify(sel || "")}) : document.body)?.innerText ?? "(no match)"`);
  },

  /** size <w> <h> — viewport size, e.g. `size 820 860` for the narrow layout. */
  async size(arg) {
    const [w, h] = arg.split(/\s+/).map(Number);
    NEED_ARG(w && h, "size <width> <height>");
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    return "OK";
  },

  /** theme light|dark — emulate the OS colour scheme. */
  async theme(t) {
    NEED_ARG(t === "light" || t === "dark", "theme light|dark");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }] });
    return "OK";
  },

  /** list — back to the welcome list (Esc out of a tree first). */
  async list() {
    if (await evaluate(`!!document.querySelector(".toolbar")`)) await COMMANDS.key("Escape");
    await waitFor(`!!document.querySelector(".mode-toggle")`, "the welcome screen");
    return evaluate(`(() => { [...document.querySelectorAll(".mode-toggle button")].find((b) => b.textContent.trim() === "List").click(); return "OK"; })()`);
  },

  /** day [YYYY-MM-DD] — the day view, on that day (default: today); waits for it to draw. */
  async day(key) {
    if (await evaluate(`!!document.querySelector(".toolbar")`)) await COMMANDS.key("Escape");
    await waitFor(`!!document.querySelector(".mode-toggle")`, "the welcome screen");
    await evaluate(`[...document.querySelectorAll(".mode-toggle button")].find((b) => b.textContent.trim() === "Day").click()`);
    await waitFor(`!!document.querySelector(".day-date")`, "the day view");
    if (key) await COMMANDS.fill(`.day-date ${key}`);
    await waitFor(
      `!!document.querySelector(".day-dot") || /No activity on|matches the filters/.test(document.body.innerText)`,
      "the day's turns",
    );
    return evaluate(`document.querySelector(".day-head").innerText.replace(/\\s+/g, " ")`);
  },

  /** open <title text> — open a conversation from the list by (part of) its card title. */
  async open(title) {
    NEED_ARG(title, "open <title text>");
    await COMMANDS.list();
    const r = await evaluate(`(() => {
      const card = [...document.querySelectorAll(".tree-main")].find((b) => b.querySelector(".tree-title")?.textContent.includes(${JSON.stringify(title)}));
      if (!card) return "NOT_FOUND";
      card.click();
      return "OK";
    })()`);
    if (r !== "OK") return r;
    await waitFor(`!!document.querySelector(".toolbar")`, "the tree");
    return evaluate(`document.querySelector(".tree-name").innerText`);
  },

  async quit() {
    ws?.close();
    child?.kill();
    child = null;
    ws = null;
    return "bye";
  },

  help() {
    return `commands: ${Object.keys(COMMANDS).join(", ")} (see SKILL.md)`;
  },
};

/**
 * Forks write into the harness's own store. On real stores that is never
 * done from here (AGENTS.md: never test forks against original stores).
 */
function guard(text) {
  if (mode === "real" && /fork after|fork this/i.test(text)) {
    throw new Error("refused: forking writes to your real store; launch fixtures for fork checks");
  }
}

const interactive = process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, terminal: interactive });
console.log(`agentree driver — "help" for commands, "launch [fixtures|real]" to start; screenshots in ${SHOTS}`);
if (interactive) process.stdout.write("driver> ");
for await (const line of rl) {
  const text = line.trim();
  if (text && !text.startsWith("#")) {
    const [cmd, ...rest] = text.split(/\s+/);
    const fn = COMMANDS[cmd];
    if (!fn) console.log(`unknown: ${cmd} — try: help`);
    else {
      try {
        console.log(`${cmd}: ${await fn(rest.join(" "))}`);
      } catch (e) {
        console.log(`${cmd}: ERROR ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (cmd === "quit") break;
  }
  if (interactive) process.stdout.write("driver> ");
}
await COMMANDS.quit();
process.exit(0);
