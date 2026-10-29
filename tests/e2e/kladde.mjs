// End-to-end harness: starts a Kladde build with an isolated profile and drives its WebView through
// the Chrome DevTools Protocol. Input goes only into Kladde's page, never to the desktop.
//
//   const app = await launch({ port: 9341, files: ["C:/tmp/a.txt"] });
//   await app.key("Ctrl+T");
//   await app.type("hello");
//   console.log(await app.state());
//   await app.close();      // like closing the window (hot exit)
//   await app.kill();       // like a crash
//
// The profile (settings, session, backups, WebView data) lives in a temporary folder that survives
// kill/close, so a second launch with the same `profile` restores the session.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEBUG_EXE = join(root, "src-tauri/target/debug/kladde.exe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh temporary profile folder. */
export function tempProfile(name = "kladde-e2e") {
  const dir = join(tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Whether something accepts connections on a local port. */
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

/**
 * Waits until nobody listens on the port. WebView2's browser process outlives the app by a moment and keeps
 * serving its DevTools endpoint; a launch in that window would attach to the dying page and fail in odd ways
 * ("Uncaught (in promise)" from a command while the app exits).
 */
async function portReleased(port, timeout = 15000) {
  const end = Date.now() + timeout;
  while (await listening(port)) {
    if (Date.now() > end) return false;
    await sleep(100);
  }
  return true;
}

/** Writes a file into a folder and returns its path. */
export function writeFixture(dir, name, content) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const KEYS = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  Plus: 187, Minus: 189,
};
const ALIASES = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Esc: "Escape" };

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

/**
 * Starts Kladde. Options: exe (default: the debug build), port (DevTools port, unique per parallel
 * run), profile (folder; default: a fresh temporary one), files (paths to open), env (extra variables).
 */
export async function launch({ exe = DEBUG_EXE, port = 9341, profile = tempProfile(), files = [], env = {} } = {}) {
  // Kladde sets up WebView2 itself for an isolated profile (its own WebView2 folder inside the data folder,
  // the DevTools port from KLADDE_DEVTOOLS_PORT): WebView2's own environment variables are ignored on the
  // GitHub runner. Inherited ones are dropped so they cannot override what Kladde passes.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^WEBVIEW2_/i.test(name)));
  if (!(await portReleased(port))) throw new Error(`DevTools port ${port} is still in use by another process`);
  const child = spawn(exe, files, {
    env: {
      ...inherited,
      KLADDE_DATA_DIR: join(profile, "data"),
      KLADDE_DEVTOOLS_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  // Cold starts on CI runners (first WebView2 start) can take much longer than locally.
  const startTimeout = Number(process.env.KLADDE_E2E_START_TIMEOUT ?? 20000);
  const started = Date.now();
  let page;
  while (!page && Date.now() - started < startTimeout && child.exitCode === null) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
    if (!page) await sleep(100);
  }
  if (!page) {
    const exit = child.exitCode === null ? "still running" : `exited with code ${child.exitCode}`;
    child.kill();
    throw new Error(`Kladde did not start within ${Date.now() - started} ms (port ${port}, ${exit}). stderr:\n${stderr}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const cdp = new Cdp(ws);
  // The page behaves as if its window had the focus, whatever else is in front on the desktop: Kladde
  // only checks for changed files while focused, and tests must not depend on the desktop.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const app = {
    child,
    cdp,
    profile,
    stderr: () => stderr,

    /** Evaluates an expression in the page (awaits promises) and returns its value. */
    async eval(expression) {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        // A rejected Tauri command rejects with a plain string: without its value the error would only
        // read "Uncaught (in promise)".
        const e = r.exceptionDetails.exception;
        throw new Error(e?.description ?? (e?.value !== undefined ? `${r.exceptionDetails.text} ${JSON.stringify(e.value)}` : r.exceptionDetails.text));
      }
      return r.result.value;
    },

    /** Waits until the expression is truthy. */
    async waitFor(expression, timeout = 5000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await app.eval(expression).catch(() => false)) return;
        await sleep(50);
      }
      throw new Error(`Timed out waiting for: ${expression}`);
    },

    /** Presses a key combination, e.g. "Ctrl+Shift+P", "Alt+Left", "F5", "Enter". */
    async key(combo) {
      const parts = combo.split("+");
      let k = parts.pop();
      if (k === "" && combo.endsWith("+")) k = "Plus";
      k = ALIASES[k] ?? k;
      const has = (m) => parts.includes(m);
      const modifiers = (has("Alt") ? 1 : 0) | (has("Ctrl") ? 2 : 0) | (has("Shift") ? 8 : 0);
      const single = k.length === 1;
      const key = single ? (has("Shift") ? k.toUpperCase() : k.toLowerCase()) : k === "Plus" ? "+" : k === "Minus" ? "-" : k === "Space" ? " " : k;
      const code = single ? (/\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`) : k === "Plus" ? "Equal" : k === "Minus" ? "Minus" : k;
      const vk = single ? k.toUpperCase().charCodeAt(0) : KEYS[k];
      const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await cdp.send("Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
      if (single && !has("Ctrl") && !has("Alt")) await cdp.send("Input.dispatchKeyEvent", { ...base, type: "char", text: key });
      await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      await sleep(30);
      // The command palette opens asynchronously: wait for it, so text typed next lands in its input.
      if (combo === "Ctrl+Shift+P" || combo === "F1") {
        try {
          await app.waitFor("document.activeElement?.matches('.picker input')");
        } catch (e) {
          const seen = await app.eval(`JSON.stringify({ picker: !!document.querySelector('.picker'), active: document.activeElement?.outerHTML.slice(0, 120), visibility: document.visibilityState, focus: document.hasFocus(), keymap: document.querySelector('.cm-editor') !== null })`).catch((x) => String(x));
          throw new Error(`${e.message} ${seen}`);
        }
      }
    },

    /** Types text into the focused element. */
    async type(text) {
      await cdp.send("Input.insertText", { text });
      await sleep(30);
    },

    /** Mouse wheel at a point, with optional modifiers (2 = Ctrl). */
    async wheel(deltaY, { x = 400, y = 300, modifiers = 0 } = {}) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers });
    },

    async click(selector) {
      await app.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("no element ${selector.replace(/"/g, "'")}"); el.click(); return true; })()`);
      await sleep(50);
    },

    /** Saves a PNG of the page. */
    async screenshot(path, { width, height, scale } = {}) {
      if (width) await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale ?? 1, mobile: false });
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
      if (width) await cdp.send("Emulation.clearDeviceMetricsOverride");
    },

    /** Tabs, the active tab, unsaved tabs, editor text, open dialog and notice. */
    state() {
      return app.eval(`({
        active: document.querySelector('.tab.active .title')?.textContent ?? null,
        tabs: [...document.querySelectorAll('.tab .title')].map((t) => t.textContent),
        dirty: [...document.querySelectorAll('.tab.dirty .title')].map((t) => t.textContent),
        text: document.querySelector('.cm-content')?.innerText ?? null,
        dialog: document.querySelector('.dialog .message')?.textContent ?? null,
        notice: document.querySelector('.notice span')?.textContent ?? null,
      })`);
    },

    /** Closes the window like the user does (Kladde saves the session). */
    async close() {
      ws.close();
      try {
        execFileSync("taskkill", ["/PID", String(child.pid)], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      await exited(child, 10000);
    },

    /** Kills the process without warning, like a crash. */
    async kill() {
      ws.close();
      child.kill("SIGKILL");
      await exited(child, 10000);
    },
  };
  // The page can come up long before the app has mounted (slow CI runners), so the start timeout applies
  // here too. A failed start must not leave the process or the socket behind: the test runner would wait
  // for them forever.
  try {
    await app.waitFor("document.documentElement.dataset.ready !== undefined && document.querySelector('.tab')", Math.max(10000, startTimeout - (Date.now() - started)));
  } catch (e) {
    await app.kill();
    throw new Error(`${e.message} (port ${port}). stderr:
${stderr}`);
  }
  return app;
}

function exited(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      // Give WebView2 a moment to release the profile folder.
      setTimeout(resolve, 500);
    });
  });
}

/** Deletes a profile folder (retrying while WebView2 still holds files). */
export async function removeProfile(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250);
    }
  }
}
