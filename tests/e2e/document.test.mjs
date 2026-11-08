// The read-only document viewer (tab kind "document", Word documents): opening, focus and keys, scroll position,
// reloading while a program saves, selection and copy, links, zoom, the errors, "Open as text", session restore, and
// that a hostile document can neither reach the network nor draw over the app. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// The documents are generated here with the `docx` package (docx-fixtures.mjs); nothing is committed as a binary.
// Input goes into the page through DevTools only. External links are not opened (KLADDE_OPEN_URL_LOG).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";
import {
  makeCorrupt,
  makeDocx,
  makeEncryptedSignature,
  makeHostileDocx,
  makeTrackedDocx,
  truncate,
} from "./docx-fixtures.mjs";

const profile = tempProfile("kladde-document");
const files = join(profile, "files");
mkdirSync(files, { recursive: true });
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes a fixture into a fresh folder of its own, so the tests do not see each other's files. */
function put(name, content) {
  const dir = join(files, `${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// The view of the shown document tab (others are kept alive but hidden), its shadow root and the page text.
const VIEW = "document.querySelector('.fill:not(.hidden) .document-view')";
const HOST = `${VIEW}?.querySelector('.host')`;
const ROOT = `${HOST}?.shadowRoot`;
const PANE = `${VIEW}?.querySelector('.pane')`;
const TEXT = `${ROOT}?.querySelector('.docx-wrapper')?.innerText ?? ''`;
const activeIs = (title) => `document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(title)}`;
const shows = (text) => `(${TEXT}).includes(${JSON.stringify(text)})`;
const scrollTop = (app) => app.eval(`${PANE}?.scrollTop ?? -1`);

/** Starts Kladde with files open; `data` files (settings.json) go into the profile first. */
async function session({ port, paths = [], env = {}, settings, dir = tempProfile("kladde-document-run") }, body) {
  if (settings) writeFixture(join(dir, "data"), "settings.json", JSON.stringify(settings));
  const app = await launch({ port, profile: dir, files: paths, env });
  try {
    await body(app, dir);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
}

/** A real click on a tab, like the user's. */
async function clickTab(app, title) {
  const { x, y } = await app.eval(`(() => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.title')?.textContent === ${JSON.stringify(title)});
    const r = tab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await app.waitFor(activeIs(title));
}

async function clickAt(app, { x, y }) {
  await app.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await app.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
  await sleep(150);
}

/** The center of the first element in the document that matches, in window coordinates. */
const centerOf = (app, selector) =>
  app.eval(`(() => {
    const el = ${ROOT}?.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

test("a .docx opens in the viewer, before the large file check, and shows its text", async () => {
  const doc = put("basic.docx", await makeDocx({ pages: 4 }));
  // Everything above 1 KB would open in the large file viewer: a document goes to its own viewer first.
  await session({ port: 9427, paths: [doc], settings: { largeFileThresholdMB: 0.001 } }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    const state = await app.eval(`({
      tab: document.querySelector('.tab.active .title').textContent,
      editorHidden: document.querySelector('.editor').classList.contains('hidden'),
      large: !!document.querySelector('.large'),
      status: document.querySelector('footer').innerText.replace(/\\s+/g, ' '),
      pages: ${ROOT}.querySelectorAll('section.docx').length,
      font: getComputedStyle(${HOST}).fontFamily,
      pageBackground: getComputedStyle(${ROOT}.querySelector('section.docx')).backgroundColor,
      table: ${TEXT}.includes('Cell B1'),
    })`);
    assert.equal(state.tab, "basic.docx");
    assert.equal(state.editorHidden, true);
    assert.equal(state.large, false);
    assert.match(state.status, /Word document \(read-only\)/);
    assert.match(state.status, /4 pages/);
    assert.match(state.status, /KB/);
    assert.equal(state.pages, 4);
    // The default document font, not the UI font.
    assert.match(state.font, /Calibri/);
    assert.doesNotMatch(state.font, /Inter/);
    // White pages whatever the theme.
    assert.equal(state.pageBackground, "rgb(255, 255, 255)");
    assert.ok(state.table);
    // The document is a view: nothing to save, no dirty mark.
    assert.deepEqual((await app.state()).dirty, []);
  });
});

test("tracked changes and comments are shown as such", async () => {
  const doc = put("tracked.docx", await makeTrackedDocx());
  await session({ port: 9428, paths: [doc] }, async (app) => {
    await app.waitFor(shows("one hundred"), 20000);
    const state = await app.eval(`(() => {
      const root = ${ROOT};
      const style = (sel) => getComputedStyle(root.querySelector(sel));
      return {
        deleted: root.querySelector('del')?.textContent,
        inserted: root.querySelector('ins')?.textContent,
        delDecoration: style('del').textDecorationLine,
        insDecoration: style('ins').textDecorationLine,
        delColor: style('del span').color,
        insColor: style('ins span').color,
        marker: root.querySelector('.docx-comment-ref')?.textContent,
        popover: root.querySelector('.docx-comment-popover')?.textContent,
        popoverShown: getComputedStyle(root.querySelector('.docx-comment-popover')).display,
      };
    })()`);
    assert.equal(state.deleted, "ninety");
    assert.equal(state.inserted, "one hundred");
    assert.match(state.delDecoration, /line-through/);
    assert.match(state.insDecoration, /underline/);
    assert.notEqual(state.delColor, state.insColor);
    assert.ok(state.marker);
    assert.match(state.popover, /Please check this price/);
    assert.equal(state.popoverShown, "none");
  });
});

test("the focus is in the viewer, so PageDown scrolls; it returns after the palette closes; scroll position survives tab switches and reloads", async () => {
  const doc = put("long.docx", await makeDocx({ pages: 5 }));
  const other = writeFixture(profile, "other.txt", "just text\n");
  await session({ port: 9429, paths: [doc, other] }, async (app) => {
    // The text file opened last and is active; the document renders in the background of its first visit.
    await app.waitFor(activeIs("other.txt"));
    // Activating the document tab (a real click) is all the test does: the viewer must take the focus itself.
    await clickTab(app, "long.docx");
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    assert.equal(await scrollTop(app), 0);
    await app.key("PageDown");
    await app.waitFor(`${PANE}.scrollTop > 100`);
    await app.key("PageDown");
    await sleep(300);
    const kept = await scrollTop(app);
    assert.ok(kept > 500, `scrolled ${kept}`);

    // The palette takes the focus and gives it back to the document.
    await app.key("Ctrl+Shift+P");
    await app.key("Escape");
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);

    // Away and back: the place is the same.
    await clickTab(app, "other.txt");
    await app.waitFor(`!document.querySelector('.fill:not(.hidden) .document-view')`);
    await clickTab(app, "long.docx");
    await app.waitFor(`Math.abs(${PANE}.scrollTop - ${kept}) < 3`);
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);

    // The file changes on disk (here the same document with other text): the viewer follows by itself and stays
    // where it was.
    const path = doc;
    writeFileSync(path, await makeDocx({ pages: 5, marker: "Reloaded from disk" }));
    await app.waitFor(shows("Reloaded from disk"), 15000);
    await sleep(300);
    assert.ok(Math.abs((await scrollTop(app)) - kept) < 3, `scroll after reload: ${await scrollTop(app)} (was ${kept})`);

    // F5 renders again without a change on disk.
    await app.eval(`${ROOT}.querySelector('.docx-wrapper').setAttribute('data-probe', '1')`);
    await app.key("F5");
    await app.waitFor(`!${ROOT}.querySelector('.docx-wrapper[data-probe]') && ${shows("Reloaded from disk")}`);
    await sleep(300);
    assert.ok(Math.abs((await scrollTop(app)) - kept) < 3);
    assert.equal(await app.eval(`!!${VIEW}?.querySelector('.problem')`), false);
  });
});

test("a file that is half written is read again instead of showing an error", async () => {
  const bytes = await makeDocx({ pages: 2, marker: "Complete document" });
  const doc = put("saving.docx", bytes);
  await session({ port: 9430, paths: [doc] }, async (app) => {
    await app.waitFor(shows("Complete document"), 20000);
    // A save in progress: the start of the new file is there, the rest is not yet.
    writeFileSync(doc, truncate(await makeDocx({ pages: 2, marker: "Second version" })));
    const seen = [];
    const until = Date.now() + 3500;
    while (Date.now() < until) {
      seen.push(await app.eval(`({ problem: !!${VIEW}?.querySelector('.problem'), complete: ${shows("Complete document")} })`));
      await sleep(150);
    }
    assert.ok(seen.every((s) => !s.problem), "an error flashed while the file was half written");
    assert.ok(seen.every((s) => s.complete), "the old rendering went away");
    // The save finishes.
    writeFileSync(doc, await makeDocx({ pages: 2, marker: "Second version" }));
    await app.waitFor(shows("Second version"), 15000);
    assert.equal(await app.eval(`!!${VIEW}?.querySelector('.problem')`), false);
  });
});

test("Ctrl+A selects the document only, Ctrl+C copies, the context menu is Kladde's own and only with a selection", async () => {
  const doc = put("select.docx", await makeDocx({ pages: 2 }));
  await session({ port: 9431, paths: [doc] }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    // What the page would learn from a copy event.
    await app.eval(`window.__copied = null; document.addEventListener('copy', (e) => { window.__copied = { text: getSelection().toString(), prevented: e.defaultPrevented }; });`);
    await app.key("Ctrl+A");
    const selected = await app.eval(`getSelection().toString()`);
    assert.match(selected, /Kladde viewer test document/);
    assert.match(selected, /Page 2 line 12/);
    // Not the tab bar, the status bar or anything else around it.
    assert.doesNotMatch(selected, /select\.docx|read-only/);
    await app.key("Ctrl+C");
    await app.waitFor(`window.__copied !== null`);
    assert.deepEqual(await app.eval(`window.__copied.prevented`), false);
    assert.match(await app.eval(`window.__copied.text`), /Kladde viewer test document/);

    // The context menu: ours, with Copy, while text is selected; the WebView's own never (the event is cancelled).
    const point = await centerOf(app, "section.docx p");
    const asked = () => app.eval(`(() => {
      const target = ${ROOT}.querySelector('section.docx p');
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: ${point.x}, clientY: ${point.y} });
      const notPrevented = target.dispatchEvent(event);
      // The menu is drawn a moment later.
      return new Promise((resolve) => setTimeout(() => resolve({ prevented: !notPrevented, menu: [...document.querySelectorAll('.menu button')].map((b) => b.textContent) }), 150));
    })()`);
    const withSelection = await asked();
    assert.equal(withSelection.prevented, true);
    assert.deepEqual(withSelection.menu, ["Copy"]);
    await app.eval(`getSelection().removeAllRanges()`);
    await app.key("Escape");
    await app.waitFor(`!document.querySelector('.menu')`);
    const without = await asked();
    assert.equal(without.prevented, true);
    assert.deepEqual(without.menu, []);
  });
});

test("Kladde's shortcuts keep working while the viewer has the focus", async () => {
  const doc = put("keys.docx", await makeDocx({ pages: 2 }));
  const other = writeFixture(profile, "keys-other.txt", "text\n");
  await session({ port: 9432, paths: [other, doc] }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    await app.key("Ctrl+Shift+P");
    assert.equal(await app.eval(`!!document.querySelector('.picker')`), true);
    // Other tabs' commands are listed; the document's own one too.
    assert.equal(await app.eval(`[...document.querySelectorAll('.picker [role=option] span:first-child')].some((e) => e.textContent === 'Open as text')`), true);
    await app.key("Escape");
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    await app.key("Ctrl+Tab");
    await app.waitFor(activeIs("keys-other.txt"));
    await app.key("Ctrl+Tab");
    await app.waitFor(activeIs("keys.docx"));
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    await app.key("Alt+Left");
    await app.waitFor(activeIs("keys-other.txt"));
    await app.key("Alt+Right");
    await app.waitFor(activeIs("keys.docx"));
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    // Closing with the key while the viewer has the focus.
    await app.key("Ctrl+W");
    await app.waitFor(activeIs("keys-other.txt"));
    assert.deepEqual((await app.state()).tabs, ["keys-other.txt"]);
  });
});

test("zoom keys and Ctrl+wheel scale the pages, and they fit a narrow window", async () => {
  const doc = put("zoom.docx", await makeDocx({ pages: 2 }));
  await session({ port: 9433, paths: [doc] }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(`document.activeElement?.classList.contains('pane')`);
    const scale = () => app.eval(`parseFloat(${HOST}.dataset.scale ?? '1')`);
    const pageWidth = () => app.eval(`${ROOT}.querySelector('section.docx').getBoundingClientRect().width`);
    const base = await scale();
    const baseWidth = await pageWidth();
    // At the default zoom the page is shown at its size, or shrunk to fit; never enlarged.
    assert.ok(base <= 1.0001);
    for (let i = 0; i < 3; i++) await app.key("Ctrl+Plus");
    await app.waitFor(`parseFloat(${HOST}.dataset.scale) > ${base} + 0.1`);
    assert.ok((await pageWidth()) > baseWidth * 1.1);
    const zoomed = await scale();
    await app.wheel(-120, { x: 500, y: 300, modifiers: 2 });
    await app.waitFor(`parseFloat(${HOST}.dataset.scale) > ${zoomed}`);
    await app.key("Ctrl+0");
    await app.waitFor(`Math.abs(parseFloat(${HOST}.dataset.scale) - ${base}) < 0.001`);
    await app.key("Ctrl+Minus");
    await app.waitFor(`parseFloat(${HOST}.dataset.scale) < ${base}`);
    await app.key("Ctrl+0");

    // A narrow window: the pages shrink to fit its width.
    await app.cdp.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 700, deviceScaleFactor: 1, mobile: false });
    try {
      await app.waitFor(`parseFloat(${HOST}.dataset.scale) < 0.7`);
      const fit = await app.eval(`(() => {
        const pane = ${PANE};
        return { page: ${ROOT}.querySelector('section.docx').getBoundingClientRect().width, pane: pane.clientWidth, scrolls: pane.scrollWidth > pane.clientWidth + 1 };
      })()`);
      assert.ok(fit.page <= fit.pane, `page ${fit.page} in ${fit.pane}`);
      assert.equal(fit.scrolls, false);
    } finally {
      await app.cdp.send("Emulation.clearDeviceMetricsOverride");
    }
  });
});

test("a link click reaches openHref: web and mail addresses open, anything else does nothing, bookmarks scroll", async () => {
  const doc = put(
    "links.docx",
    await makeDocx({
      pages: 4,
      links: [
        ["Web link", "https://example.com/docs"],
        ["Mail link", "mailto:me@example.com"],
        ["Odd link", "foo-app:open"],
        ["Script link", "javascript:void(0)"],
      ],
    }),
  );
  const dir = tempProfile("kladde-document-links");
  const log = join(dir, "urls.log");
  const urls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  await session({ port: 9434, paths: [doc], dir, env: { KLADDE_OPEN_URL_LOG: log } }, async (app) => {
    await app.waitFor(shows("Web link"), 20000);
    const linkPoint = (text) =>
      app.eval(`(() => {
        const a = [...${ROOT}.querySelectorAll('a')].find((a) => a.textContent === ${JSON.stringify(text)});
        const r = a.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    await clickAt(app, await linkPoint("Web link"));
    for (let i = 0; i < 40 && urls().length < 1; i++) await sleep(50);
    assert.deepEqual(urls(), ["https://example.com/docs"]);
    await clickAt(app, await linkPoint("Mail link"));
    for (let i = 0; i < 40 && urls().length < 2; i++) await sleep(50);
    assert.deepEqual(urls(), ["https://example.com/docs", "mailto:me@example.com"]);
    await clickAt(app, await linkPoint("Odd link"));
    await clickAt(app, await linkPoint("Script link"));
    await sleep(400);
    assert.equal(urls().length, 2);
    // The page around it is still Kladde.
    assert.equal(await app.eval(`!!document.querySelector('.tabbar') && !!${HOST}`), true);

    // A link to a bookmark scrolls to it.
    const before = await scrollTop(app);
    await clickAt(app, await linkPoint("Jump to page 3"));
    await app.waitFor(`${PANE}.scrollTop > ${before} + 500`);
    assert.equal(urls().length, 2);
  });
});

test("a document cannot reach the network or draw over Kladde's UI", async () => {
  // Anything that connects to this port is a leak. The server never answers.
  const hits = [];
  const server = net.createServer((socket) => {
    hits.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: remotePort } = server.address();
  const doc = put(
    "hostile.docx",
    await makeHostileDocx({ remote: `https://127.0.0.1:${remotePort}`, plain: `http://127.0.0.1:${remotePort}` }),
  );
  const dir = tempProfile("kladde-document-hostile");
  try {
    await session({ port: 9435, paths: [doc], dir }, async (app) => {
      // Every request of the page, through a second DevTools connection of our own.
      const targets = await (await fetch("http://127.0.0.1:9435/json")).json();
      const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
      await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
      const requests = [];
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
      };
      ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
      try {
        // The document is rendered after the listener is in: render again (F5), whatever came first.
        await app.waitFor(shows("Hostile document text"), 20000);
        await app.waitFor(`document.activeElement?.classList.contains('pane')`);
        await app.key("F5");
        await app.waitFor(`${HOST}.dataset.removed !== undefined`);
        await sleep(2500);

        // The material was there, and the cleaning took it out.
        const state = await app.eval(`(() => {
          const root = ${ROOT};
          const css = [...root.querySelectorAll('style')].map((s) => s.textContent).join('\\n');
          const attrs = [...root.querySelectorAll('[style]')].map((e) => e.getAttribute('style')).join('\\n');
          return {
            removed: Number(${HOST}.dataset.removed),
            remoteInCss: /https?:/i.test(css),
            remoteInAttributes: /https?:/i.test(attrs),
            images: [...root.querySelectorAll('img')].map((i) => i.getAttribute('src')),
            styled: !!root.querySelector('.docx_evil'),
            fixedKept: [...root.querySelectorAll('svg')].some((s) => s.style.position === 'fixed') || /position:\\s*fixed/.test(css),
          };
        })()`);
        assert.ok(state.removed >= 3, `only ${state.removed} things were removed`);
        assert.equal(state.remoteInCss, false);
        assert.equal(state.remoteInAttributes, false);
        assert.deepEqual(state.images, []);
        assert.ok(state.styled);
        assert.ok(state.fixedKept, "the fixed position is part of what the test needs to contain");

        // No http or https request left the viewer: nothing connected to the port, and the page asked for no
        // address outside its own origins.
        assert.deepEqual(hits, []);
        const foreign = requests.filter((u) => /^https?:/i.test(u) && !/^https?:\/\/(tauri|ipc|asset)\.localhost[:/]/i.test(u));
        assert.deepEqual(foreign, []);

        // `position: fixed` stays inside the viewer: the tab bar and the status bar are still what a click
        // hits, while the document itself is covered.
        const where = await app.eval(`(() => {
          const at = (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
          const host = ${HOST};
          const tabs = document.querySelector('.tabbar');
          const footer = document.querySelector('footer');
          const hit = (el) => at(el)?.closest('.tabbar, footer, .document-view')?.className;
          const inside = { x: host.getBoundingClientRect().left + 50, y: host.getBoundingClientRect().top + 50 };
          const contained = { tabs: !!at(tabs)?.closest('.tabbar'), footer: !!at(footer)?.closest('footer'), insideIsDocument: document.elementFromPoint(inside.x, inside.y) === host };
          // Without the containment the same document does cover them: the test can fail.
          host.style.contain = 'none';
          const uncontained = { tabs: !!at(tabs)?.closest('.tabbar'), footer: !!at(footer)?.closest('footer') };
          host.style.contain = '';
          return { contained, uncontained };
        })()`);
        assert.deepEqual(where.contained, { tabs: true, footer: true, insideIsDocument: true });
        assert.deepEqual(where.uncontained, { tabs: false, footer: false });
      } finally {
        ws.close();
      }
    });
  } finally {
    server.close();
  }
});

test("encrypted, corrupt, not-a-document and too large files show an error with both ways out", async () => {
  const encrypted = put("encrypted.docx", makeEncryptedSignature());
  const corrupt = put("corrupt.docx", makeCorrupt());
  const notZip = put("notzip.docx", "This is plain text with a document name.\n");
  const big = put("big.docx", Buffer.alloc(51 * 1024 * 1024));
  const dir = tempProfile("kladde-document-errors");
  const log = join(dir, "opened.log");
  await session({ port: 9436, paths: [encrypted, corrupt, notZip, big], dir, env: { KLADDE_OPEN_URL_LOG: log } }, async (app) => {
    const problem = () =>
      app.eval(`(() => {
        const box = ${VIEW}?.querySelector('.problem');
        return box ? { text: box.innerText, buttons: [...box.querySelectorAll('button')].map((b) => b.textContent), focused: document.activeElement === box } : null;
      })()`);
    const expectations = [
      ["encrypted.docx", /encrypted or protected by rights management/],
      ["corrupt.docx", /could not be read/],
      ["notzip.docx", /not a Word document/],
      ["big.docx", /51\.0 MB.*50 MB/s],
    ];
    for (const [title, pattern] of expectations) {
      await clickTab(app, title);
      await app.waitFor(`!!${VIEW}?.querySelector('.problem')`, 20000);
      // The message takes the focus, so the keys keep working there too.
      await app.waitFor(`document.activeElement === ${VIEW}.querySelector('.problem')`);
      const shown = await problem();
      assert.match(shown.text, pattern, title);
      assert.match(shown.text, new RegExp(`${title} cannot be shown`));
      assert.deepEqual(shown.buttons, ["Open in default app", "Open as text"], title);
      // The page of the document itself is not shown next to the message.
      assert.equal(await app.eval(`getComputedStyle(${PANE}).display`), "none", title);
      assert.equal(shown.focused, true, title);
    }

    // "Open in default app" asks Windows (here: the test log takes the path instead of Word starting).
    await clickTab(app, "encrypted.docx");
    await app.waitFor(`!!${VIEW}?.querySelector('.problem')`);
    await app.click(`.fill:not(.hidden) .problem button`);
    for (let i = 0; i < 40 && !existsSync(log); i++) await sleep(50);
    assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), [encrypted]);

    // "Open as text" replaces the document tab with a text tab of the same file.
    await clickTab(app, "corrupt.docx");
    await app.waitFor(`!!${VIEW}?.querySelector('.problem')`);
    await app.eval(`[...${VIEW}.querySelectorAll('.problem button')].find((b) => b.textContent === 'Open as text').click()`);
    await app.waitFor(`!document.querySelector('.editor').classList.contains('hidden') && document.querySelector('.tab.active .title')?.textContent === 'corrupt.docx'`);
    const state = await app.state();
    assert.deepEqual(state.tabs, ["encrypted.docx", "notzip.docx", "big.docx", "corrupt.docx"]);
    assert.match(state.text, /^PK.{0,4}AAAA/);
    assert.equal(await app.eval(`!document.querySelector('.fill:not(.hidden) .document-view')`), true);
  });
});

test("\"Open as text\" is also a command of the palette, for a document tab only", async () => {
  const doc = put("palette.docx", await makeDocx({ pages: 1 }));
  const other = writeFixture(profile, "palette-other.txt", "plain\n");
  await session({ port: 9437, paths: [doc, other] }, async (app) => {
    await app.waitFor(activeIs("palette-other.txt"));
    const listed = async () => {
      await app.key("Ctrl+Shift+P");
      await app.type("open as text");
      return app.eval(`[...document.querySelectorAll('.picker [role=option] span:first-child')].some((e) => e.textContent === 'Open as text')`);
    };
    // Not offered for a text tab ...
    assert.equal(await listed(), false);
    await app.key("Escape");
    // ... offered, and working, for the document.
    await clickTab(app, "palette.docx");
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    assert.equal(await listed(), true);
    await app.key("Enter");
    await app.waitFor(`!document.querySelector('.editor').classList.contains('hidden') && document.querySelector('.tab.active .title')?.textContent === 'palette.docx'`);
    const state = await app.state();
    assert.deepEqual(state.tabs, ["palette-other.txt", "palette.docx"]);
    assert.match(state.text, /^PK/);
  });
});

test("the session restores a document tab by its path, with its place, and the file names its kind", async () => {
  const doc = put("restore.docx", await makeDocx({ pages: 5 }));
  const other = writeFixture(profile, "restore-other.txt", "text\n");
  const dir = tempProfile("kladde-document-restore");
  let kept = 0;
  try {
    let app = await launch({ port: 9438, profile: dir, files: [other, doc] });
    try {
      await app.waitFor(shows("Kladde viewer test document"), 20000);
      await app.waitFor(`document.activeElement?.classList.contains('pane')`);
      await app.key("PageDown");
      await app.key("PageDown");
      await app.waitFor(`${PANE}.scrollTop > 500`);
      await sleep(300);
      kept = await scrollTop(app);
    } finally {
      await app.close();
    }
    const session = JSON.parse(readFileSync(join(dir, "data", "session.json"), "utf8"));
    const saved = session.tabs.find((t) => t.path === doc);
    assert.equal(saved.kind, "document");
    assert.ok(Math.abs(saved.scrollTop - kept) < 3, `saved ${saved.scrollTop}, scrolled ${kept}`);
    assert.equal(session.activeId, saved.id);

    app = await launch({ port: 9439, profile: dir });
    try {
      assert.deepEqual((await app.state()).tabs, ["restore-other.txt", "restore.docx"]);
      await app.waitFor(shows("Kladde viewer test document"), 20000);
      await app.waitFor(`Math.abs(${PANE}.scrollTop - ${kept}) < 3`);
      assert.match(await app.eval(`document.querySelector('footer').innerText`), /Word document \(read-only\)/);
    } finally {
      await app.kill();
    }
  } finally {
    await removeProfile(dir);
  }
});
