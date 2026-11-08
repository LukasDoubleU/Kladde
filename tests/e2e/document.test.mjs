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
  ESCAPE_CSS_WAYS,
  makeCorrupt,
  makeDocx,
  makeEscapeDocx,
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

// The view of the shown document tab (others are kept alive but hidden), its frame (an iframe: the document lives in
// its own document, which scrolls itself; the page's test hooks `data-removed` and `data-scale` are on the iframe
// element) and the page text.
const VIEW = "document.querySelector('.fill:not(.hidden) .document-view')";
const FRAME = `${VIEW}?.querySelector('.frame')`;
const HOST = FRAME;
const ROOT = `${FRAME}?.contentDocument`;
const PANE = `${ROOT}?.scrollingElement`;
const FOCUSED = `document.activeElement === ${FRAME}`;
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

/** The center of the first element in the document that matches, in the frame's coordinates. */
const centerInFrame = (app, selector) =>
  app.eval(`(() => {
    const el = ${ROOT}?.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

/** The frame's box in the page: what turns the frame's coordinates into window coordinates. */
const frameBox = (app) => app.eval(`(() => { const r = ${FRAME}.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

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
      font: getComputedStyle(${ROOT}.getElementById('host')).fontFamily,
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

    // It lives in a sandboxed srcdoc frame with a policy of its own, set before anything else in it. The sandbox
    // attribute comes before srcdoc: it has to be there when the frame loads. A script put into it does not run.
    const frame = await app.eval(`(() => {
      const f = ${FRAME};
      const d = f.contentDocument;
      const names = [...f.attributes].map((a) => a.name);
      const script = d.createElement('script');
      script.textContent = 'window.__ran = 1';
      d.body.append(script);
      return {
        sandbox: f.getAttribute('sandbox'),
        sandboxFirst: names.indexOf('sandbox') < names.indexOf('srcdoc'),
        href: f.contentWindow.location.href,
        sameOrigin: f.contentWindow.origin === window.origin,
        head: [...d.head.children].map((e) => e.localName),
        csp: d.head.children[1]?.getAttribute('http-equiv') === 'Content-Security-Policy' ? d.head.children[1].content : null,
        ran: d.defaultView.__ran === 1,
      };
    })()`);
    assert.equal(frame.sandbox, "allow-same-origin");
    assert.equal(frame.sandboxFirst, true);
    assert.equal(frame.href, "about:srcdoc");
    assert.equal(frame.sameOrigin, true, "the page drives the frame, so it keeps the page's origin");
    assert.deepEqual(frame.head, ["meta", "meta", "style"]);
    assert.match(frame.csp, /default-src 'none'/);
    assert.match(frame.csp, /img-src data:(;|$)/);
    assert.match(frame.csp, /font-src data:(;|$)/);
    assert.doesNotMatch(frame.csp, /https?:|\*/);
    assert.equal(frame.ran, false);
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
    // The engine registers the ranges of comments on the page's global; they belong in the frame's own registry, where
    // the nodes are, and nowhere else (two document tabs would take each other's).
    const highlight = await app.eval(`(() => {
      const f = ${FRAME};
      const found = f.contentWindow.CSS.highlights.get('docx-comments');
      const ranges = found ? [...found] : [];
      return {
        text: ranges.map((r) => r.toString()),
        inFrame: ranges.every((r) => r.commonAncestorContainer.ownerDocument === f.contentDocument),
        onPage: CSS.highlights.has('docx-comments'),
      };
    })()`);
    assert.deepEqual(highlight.text, ["Commented words"]);
    assert.equal(highlight.inFrame, true);
    assert.equal(highlight.onPage, false);
    // The file carries no page count (the generated package has none), and the rendered boxes are no page count:
    // the status bar shows none.
    assert.match(await app.eval(`document.querySelector('footer').innerText`), /Word document \(read-only\)/);
    assert.doesNotMatch(await app.eval(`document.querySelector('footer').innerText`), /\bpages?\b/);
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
    await app.waitFor(FOCUSED);
    assert.equal(await scrollTop(app), 0);
    await app.key("PageDown");
    await app.waitFor(`${PANE}.scrollTop > 100`);
    await app.key("PageDown");
    await sleep(300);
    let kept = await scrollTop(app);
    assert.ok(kept > 500, `scrolled ${kept}`);

    // The palette takes the focus and gives it back to the document.
    await app.key("Ctrl+Shift+P");
    await app.key("Escape");
    await app.waitFor(FOCUSED);

    // Dialogs that open after the palette closed give the focus back too: the Windows registration dialog (it opens
    // when the registry has been read, after the palette's own refocus) and the key capture dialog.
    await app.key("Ctrl+Shift+P");
    await app.type("Set Kladde as default editor");
    await app.waitFor("document.querySelector('.picker [role=option]')");
    await app.key("Enter");
    await app.waitFor("document.querySelector('[aria-label=\"Default editor\"]')");
    await app.key("Escape");
    await app.waitFor("!document.querySelector('[aria-label=\"Default editor\"]')");
    await app.waitFor(FOCUSED);
    await app.key("Ctrl+Shift+P");
    await app.type("Change keyboard shortcut");
    await app.waitFor("document.querySelector('.picker [role=option]')");
    await app.key("Enter");
    for (const [placeholder, label] of [["Change the keyboard shortcut of…", "Zoom in"], ["Zoom in", "Set shortcut"]]) {
      await app.waitFor(`document.querySelector('.picker input')?.placeholder === ${JSON.stringify(placeholder)}`);
      await app.type(label);
      await app.waitFor(`document.querySelector('.picker [role=option]')?.textContent.includes(${JSON.stringify(label)})`);
      await app.key("Enter");
    }
    await app.waitFor("document.querySelector('.capture .keys')");
    await app.key("Escape");
    await app.waitFor("!document.querySelector('.capture')");
    await app.waitFor(FOCUSED);
    // And the keys work again without a click.
    const beforeKey = await scrollTop(app);
    await app.key("PageDown");
    await app.waitFor(`${PANE}.scrollTop > ${beforeKey}`);
    await sleep(300);
    kept = await scrollTop(app);

    // Away and back: the place is the same.
    await clickTab(app, "other.txt");
    await app.waitFor(`!document.querySelector('.fill:not(.hidden) .document-view')`);
    await clickTab(app, "long.docx");
    await app.waitFor(`Math.abs(${PANE}.scrollTop - ${kept}) < 3`);
    await app.waitFor(FOCUSED);

    // The file changes on disk (here the same document with other text): the viewer follows by itself and stays
    // where it was.
    const path = doc;
    // The page count is the file's own number (Word writes it on save), not the number of rendered boxes.
    writeFileSync(path, await makeDocx({ pages: 5, marker: "Reloaded from disk", appPages: 12 }));
    await app.waitFor(shows("Reloaded from disk"), 15000);
    await app.waitFor(`document.querySelector('footer').innerText.includes('12 pages')`);
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

test("a render that finishes while the tab is hidden keeps the fit, the zoom and the place", async () => {
  // A hidden tab has no layout: measuring the pages there reads 0 and used to throw away the fit to width, and
  // the place (in px of the old scale) was scaled a second time on return.
  const doc = put("hidden.docx", await makeDocx({ pages: 5 }));
  const other = writeFixture(profile, "hidden-other.txt", "just text\n");
  await session({ port: 9440, paths: [doc, other] }, async (app) => {
    await app.waitFor(activeIs("hidden-other.txt"));
    await clickTab(app, "hidden.docx");
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(FOCUSED);
    const HIDDEN = "document.querySelector('.fill.hidden .document-view .frame')?.contentDocument";
    const look = () =>
      app.eval(`(() => {
        const pane = ${PANE};
        const page = ${ROOT}.querySelector('section.docx').getBoundingClientRect().width;
        return { scale: parseFloat(${HOST}.dataset.scale ?? '1'), top: pane.scrollTop, page, pane: pane.clientWidth, hscroll: pane.scrollWidth > pane.clientWidth + 1 };
      })()`);
    // Away, render (F5 while the viewer is shown, the debounced reload then runs on the hidden tab), and back.
    const reloadHidden = async () => {
      await app.eval(`${ROOT}.querySelector('.docx-wrapper').setAttribute('data-probe', '1')`);
      await app.key("F5");
      await app.key("Ctrl+Tab");
      await app.waitFor(activeIs("hidden-other.txt"));
      // The new rendering is made while the tab is hidden: the probe on the old wrapper is gone.
      await app.waitFor(`${HIDDEN} && !${HIDDEN}.querySelector('.docx-wrapper[data-probe]')`, 15000);
      await sleep(500);
      await app.key("Ctrl+Tab");
      await app.waitFor(activeIs("hidden.docx"));
      await app.waitFor(FOCUSED);
      await sleep(500);
    };

    // A narrow window: the pages fit its width.
    await app.cdp.send("Emulation.setDeviceMetricsOverride", { width: 520, height: 700, deviceScaleFactor: 1, mobile: false });
    try {
      await app.waitFor(`parseFloat(${HOST}.dataset.scale) < 0.7`);
      await app.key("PageDown");
      await app.key("PageDown");
      await sleep(300);
      const before = await look();
      assert.ok(before.top > 500, `scrolled ${before.top}`);
      assert.equal(before.hscroll, false);
      await reloadHidden();
      const after = await look();
      assert.ok(Math.abs(after.scale - before.scale) < 0.001, `scale ${before.scale} -> ${after.scale}`);
      assert.ok(after.page <= after.pane, `page ${after.page} in ${after.pane}`);
      assert.equal(after.hscroll, false);
      assert.ok(Math.abs(after.top - before.top) < 3, `place ${before.top} -> ${after.top}`);
    } finally {
      await app.cdp.send("Emulation.clearDeviceMetricsOverride");
    }

    // A wide window with Kladde's zoom: the scale is the zoom's, and the place is not scaled again.
    await app.waitFor(`${PANE}.clientWidth > 1000 && parseFloat(${HOST}.dataset.scale) > 0.95`);
    for (let i = 0; i < 3; i++) await app.key("Ctrl+Plus");
    await app.waitFor(`parseFloat(${HOST}.dataset.scale) > 1.05`);
    await app.key("PageDown");
    await sleep(300);
    const zoomed = await look();
    await reloadHidden();
    const back = await look();
    assert.ok(Math.abs(back.scale - zoomed.scale) < 0.001, `scale ${zoomed.scale} -> ${back.scale}`);
    assert.ok(Math.abs(back.top - zoomed.top) < 3, `place ${zoomed.top} -> ${back.top}`);
  });
});

test("Ctrl+A selects the document only, Ctrl+C copies, the context menu is Kladde's own and only with a selection", async () => {
  const doc = put("select.docx", await makeDocx({ pages: 2 }));
  await session({ port: 9431, paths: [doc] }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.waitFor(FOCUSED);
    // What the page would learn from a copy event.
    // The selection and the copy event are the frame's own.
    await app.eval(`window.__copied = null; (() => { const d = ${ROOT}; d.addEventListener('copy', (e) => { window.__copied = { text: d.getSelection().toString(), prevented: e.defaultPrevented }; }); })()`);
    await app.key("Ctrl+A");
    const selected = await app.eval(`${ROOT}.getSelection().toString()`);
    assert.match(selected, /Kladde viewer test document/);
    assert.match(selected, /Page 2 line 12/);
    // Not the tab bar, the status bar or anything else around it.
    assert.doesNotMatch(selected, /select\.docx|read-only/);
    await app.key("Ctrl+C");
    await app.waitFor(`window.__copied !== null`);
    assert.deepEqual(await app.eval(`window.__copied.prevented`), false);
    assert.match(await app.eval(`window.__copied.text`), /Kladde viewer test document/);

    // The context menu: ours, with Copy, while text is selected; the WebView's own never (the event is cancelled).
    const point = await centerInFrame(app, "section.docx p");
    const box = await frameBox(app);
    const asked = () => app.eval(`(() => {
      const target = ${ROOT}.querySelector('section.docx p');
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, composed: true, clientX: ${point.x}, clientY: ${point.y} });
      const notPrevented = target.dispatchEvent(event);
      // The menu is drawn a moment later.
      return new Promise((resolve) => setTimeout(() => resolve({ prevented: !notPrevented, menu: [...document.querySelectorAll('.menu button')].map((b) => b.textContent), at: (() => { const m = document.querySelector('.menu'); return m ? { x: parseFloat(m.style.left), y: parseFloat(m.style.top) } : null; })() }), 150));
    })()`);
    const withSelection = await asked();
    assert.equal(withSelection.prevented, true);
    assert.deepEqual(withSelection.menu, ["Copy"]);
    // Where the pointer is in the window, not in the frame: the frame's coordinates are moved by the frame's place.
    assert.ok(box.left + box.top > 0, "the frame sits below the tab bar");
    assert.ok(Math.abs(withSelection.at.x - (box.left + point.x)) < 2 && Math.abs(withSelection.at.y - (box.top + point.y)) < 2, `menu at ${JSON.stringify(withSelection.at)}, pointer in the window at ${box.left + point.x},${box.top + point.y}`);
    await app.eval(`${ROOT}.getSelection().removeAllRanges()`);
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
    await app.waitFor(FOCUSED);
    // The keys go to the frame (it has the focus), and Kladde's handling of them is what runs.
    assert.equal(await app.eval(`document.activeElement === ${FRAME} && ${ROOT}.hasFocus()`), true);
    await app.key("Ctrl+Shift+P");
    assert.equal(await app.eval(`!!document.querySelector('.picker')`), true);
    // Other tabs' commands are listed; the document's own one too.
    assert.equal(await app.eval(`[...document.querySelectorAll('.picker [role=option] span:first-child')].some((e) => e.textContent === 'Open as text')`), true);
    await app.key("Escape");
    await app.waitFor(FOCUSED);
    await app.key("Ctrl+Tab");
    await app.waitFor(activeIs("keys-other.txt"));
    await app.key("Ctrl+Tab");
    await app.waitFor(activeIs("keys.docx"));
    await app.waitFor(FOCUSED);
    await app.key("Alt+Left");
    await app.waitFor(activeIs("keys-other.txt"));
    await app.key("Alt+Right");
    await app.waitFor(activeIs("keys.docx"));
    await app.waitFor(FOCUSED);
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
    await app.waitFor(FOCUSED);
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
    // The pointer is over the document: the wheel event belongs to the frame and has to reach Kladde's zoom.
    assert.equal(await app.eval(`document.elementFromPoint(500, 300) === ${FRAME}`), true);
    await app.wheel(-120, { x: 500, y: 300, modifiers: 2 });
    await app.waitFor(`parseFloat(${HOST}.dataset.scale) > ${zoomed}`);
    // Without Ctrl the wheel scrolls the document and does not zoom.
    const scaled = await scale();
    await app.wheel(300, { x: 500, y: 300 });
    await app.waitFor(`${PANE}.scrollTop > 0`);
    assert.equal(await scale(), scaled);
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
        const f = ${FRAME}.getBoundingClientRect();
        return { x: f.left + r.left + r.width / 2, y: f.top + r.top + r.height / 2 };
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
    assert.equal(await app.eval(`!!document.querySelector('.tabbar') && !!${FRAME}`), true);

    // A link to a bookmark scrolls to it.
    const before = await scrollTop(app);
    await clickAt(app, await linkPoint("Jump to page 3"));
    await app.waitFor(`${PANE}.scrollTop > ${before} + 500`);
    assert.equal(urls().length, 2);
  });
});

test("a document cannot reach the network or draw over Kladde's UI", async () => {
  // Anything that connects to one of these ports is a leak. The servers never answer. One per way in, so a failure
  // says which one got through.
  const names = ["main", "fontVar", "vmlVar", "fill", "stroke", "picture"];
  const listeners = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const hits = [];
        const server = net.createServer((socket) => {
          hits.push(socket.remoteAddress);
          socket.destroy();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        return [name, { server, hits, url: `https://127.0.0.1:${server.address().port}` }];
      }),
    ),
  );
  const probes = Object.fromEntries(names.filter((n) => n !== "main").map((n) => [n, listeners[n].url]));
  const doc = put(
    "hostile.docx",
    await makeHostileDocx({ remote: listeners.main.url, plain: listeners.main.url.replace("https:", "http:"), probes }),
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
        await app.waitFor(FOCUSED);
        await app.key("F5");
        await app.waitFor(`${HOST}.dataset.removed !== undefined`);
        await sleep(2500);

        // The material was there, and the cleaning took it out.
        const state = await app.eval(`(() => {
          const root = ${ROOT};
          const css = [...root.querySelectorAll('style')].map((s) => s.textContent).join('\\n');
          const attrs = [...root.querySelectorAll('[style]')].map((e) => e.getAttribute('style')).join('\\n');
          // Every attribute of every element, whatever its name (SVG paint attributes: fill, stroke, ...).
          const all = [...root.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name + '=' + a.value)).join('\\n');
          // What the browser computed, which is what it fetches: custom properties pasted into image-set().
          const computed = [...root.querySelectorAll('*')].map((e) => { const c = getComputedStyle(e); return c.backgroundImage + c.maskImage + c.borderImageSource + c.listStyleImage + c.content; }).join('\\n');
          const host = getComputedStyle(root.getElementById('host'));
          return {
            removed: Number(${HOST}.dataset.removed),
            remoteInCss: /https?:/i.test(css),
            remoteInAttributes: /https?:/i.test(attrs),
            remoteAnywhere: /https?:\\/\\/127\\.0\\.0\\.1/i.test(all),
            remoteComputed: /https?:/i.test(computed),
            hostRule: /:host/i.test(css),
            hostPosition: host.position,
            hostContain: host.contain,
            images: [...root.querySelectorAll('img')].map((i) => i.getAttribute('src')),
            styled: !!root.querySelector('.docx_evil'),
            svgShapes: root.querySelectorAll('svg rect, svg g').length,
            fixedKept: [...root.querySelectorAll('svg')].some((s) => s.style.position === 'fixed') || /position:\\s*fixed/.test(css),
            notice: document.querySelector('.notice')?.textContent ?? null,
          };
        })()`);
        assert.ok(state.removed >= 8, `only ${state.removed} things were removed`);
        assert.equal(state.remoteInCss, false);
        assert.equal(state.remoteInAttributes, false);
        assert.equal(state.remoteAnywhere, false);
        assert.equal(state.remoteComputed, false);
        // A rule of the document for its host element is gone, and the host is where it was put.
        assert.equal(state.hostRule, false);
        assert.notEqual(state.hostPosition, "fixed");
        assert.deepEqual(state.images, []);
        assert.ok(state.styled);
        assert.ok(state.svgShapes > 0);
        assert.ok(state.fixedKept, "the fixed position is part of what the test needs to contain");
        // A linked VML picture (its image is not in the file) is no error: the engine measures it a frame later.
        assert.equal(state.notice, null);

        // No http or https request left the viewer: nothing connected to any port, and the page asked for no
        // address outside its own origins.
        for (const name of names) assert.deepEqual(listeners[name].hits, [], `${name} was contacted`);
        const foreign = requests.filter((u) => /^https?:/i.test(u) && !/^https?:\/\/(tauri|ipc|asset)\.localhost[:/]/i.test(u));
        assert.deepEqual(foreign, []);

        // `position: fixed` (and a shape that covers the screen) stays inside the frame, which clips it: the tab bar
        // and the status bar are still what a click hits, and the frame is what a click inside it hits.
        const where = await app.eval(`(() => {
          const at = (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
          const frame = ${FRAME};
          const box = frame.getBoundingClientRect();
          const tabs = document.querySelector('.tabbar');
          const footer = document.querySelector('footer');
          const cover = [...frame.contentDocument.querySelectorAll('*')].find((e) => getComputedStyle(e).position === 'fixed');
          return {
            tabs: !!at(tabs)?.closest('.tabbar'),
            footer: !!at(footer)?.closest('footer'),
            inside: document.elementFromPoint(box.left + 50, box.top + 50) === frame,
            hasFixed: !!cover,
          };
        })()`);
        assert.deepEqual(where, { tabs: true, footer: true, inside: true, hasFixed: true });
      } finally {
        ws.close();
      }
    });
  } finally {
    for (const { server } of Object.values(listeners)) server.close();
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
      assert.equal(await app.eval(`getComputedStyle(${FRAME}).display`), "none", title);
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
      await app.waitFor(FOCUSED);
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

// ---------------------------------------------------------------------------------------------------------------
// The frame is the barrier: with the viewer's cleaning switched off, nothing a document can name leaves it.

/** Elements a document cannot make through the engine but a cleaner that let something through could leave in. */
const ELEMENT_WAYS = {
  elImg: (at) => `<img src="${at("elImg")}">`,
  elSrcset: (at) => `<img srcset="${at("elSrcset")} 1x" alt="">`,
  elPicture: (at) => `<picture><source srcset="${at("elPicture")}"><img alt=""></picture>`,
  elLinkStyle: (at) => `<link rel="stylesheet" href="${at("elLinkStyle")}">`,
  elLinkPreload: (at) => `<link rel="preload" as="image" href="${at("elLinkPreload")}">`,
  elLinkIcon: (at) => `<link rel="icon" href="${at("elLinkIcon")}">`,
  elIframe: (at) => `<iframe src="${at("elIframe")}"></iframe>`,
  elNested: (at) => `<iframe srcdoc="&lt;img src=&quot;${at("elNested")}&quot;&gt;"></iframe>`,
  elObject: (at) => `<object data="${at("elObject")}"></object>`,
  elEmbed: (at) => `<embed src="${at("elEmbed")}">`,
  elVideo: (at) => `<video src="${at("elVideo")}" poster="${at("elPoster")}" preload="auto"></video>`,
  elAudio: (at) => `<audio src="${at("elAudio")}" preload="auto"></audio>`,
  elSvgImage: (at) => `<svg width="40" height="40"><image href="${at("elSvgImage")}" width="40" height="40"/></svg>`,
  elSvgFill: (at) => `<svg width="40" height="40"><rect width="40" height="40" fill="url(${at("elSvgFill")}#g)"/></svg>`,
  elSvgUse: (at) => `<svg width="40" height="40"><use href="${at("elSvgUse")}#x"/></svg>`,
  elInput: (at) => `<input type="image" src="${at("elInput")}">`,
  elTable: (at) => `<table background="${at("elTable")}"><tr><td>x</td></tr></table>`,
  elStyleAttr: (at) => `<div style="background:url(${at("elStyleAttr")})">x</div>`,
  elStyle: (at) => `<style>@import url(${at("elStyle")}); p { background: url(${at("elStyleRule")}) }</style>`,
  elPing: (at) => `<a id="ping" href="${at("elPingHref")}" ping="${at("elPing")}">ping</a>`,
  elForm: (at) => `<form id="form" action="${at("elForm")}"><input name="a"></form>`,
  elRefresh: (at) => `<meta http-equiv="refresh" content="0;url=${at("elRefresh")}">`,
};
// Addresses that belong to an element above and have no way of their own.
const ELEMENT_ADDRESSES = ["elPoster", "elStyleRule", "elPingHref"];

test("with the cleaning switched off, the frame alone keeps a document from the network", async () => {
  // One listener per way out, so a failure names it. They never answer; a connection is a leak.
  const names = [
    ...Object.keys(ESCAPE_CSS_WAYS),
    ...["img", "svgImage", "svgFill", "svgStroke", "svgStyleFill"],
    ...Object.keys(ELEMENT_WAYS),
    ...ELEMENT_ADDRESSES,
  ];
  const listeners = {};
  for (const name of names) {
    const hits = [];
    const server = net.createServer((socket) => {
      hits.push(socket.remoteAddress);
      socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    listeners[name] = { server, hits, url: `https://127.0.0.1:${server.address().port}/${name}` };
  }
  const at = (name) => listeners[name].url;
  // A nested frame is the one thing a policy does not stop: WebView2 opens a connection when a frame starts to
  // navigate, before the policy (here and in the page itself, tried) and the app's guard, which cancels the
  // navigation, have a say. No request is ever sent (the guard's cancellation is asserted below), and the engine
  // never makes a frame (alternative chunks are off) while the cleaner removes every one: so it is not in the
  // list, and its connection is asserted to be at most that.
  const tolerated = new Set(["elIframe"]);
  const contacted = () => names.filter((name) => !tolerated.has(name) && listeners[name].hits.length > 0);
  const doc = put("escape.docx", await makeEscapeDocx({ at }));
  const dir = tempProfile("kladde-document-escape");
  try {
    await session({ port: 9445, paths: [doc], dir, env: { KLADDE_DOCUMENT_NO_CLEAN: "1" } }, async (app) => {
      await app.waitFor(shows("Escape document text"), 20000);
      await app.waitFor(`${HOST}.dataset.removed !== undefined`);

      // The hook took effect (nothing was cleaned), and the material is live: the browser parsed the addresses
      // into the rules and attributes of the frame's document.
      const material = await app.eval(`(() => {
        const d = ${ROOT};
        const css = [...d.querySelectorAll('style')].map((s) => s.textContent).join('\\n');
        const attrs = [...d.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value)).join('\\n');
        const way = [...d.querySelectorAll('span')].find((e) => e.textContent === 'Way background');
        return {
          removed: ${HOST}.dataset.removed,
          cssNamesAddresses: (css.match(/https:\\/\\/127\\.0\\.0\\.1:\\d+\\//g) ?? []).length,
          attributeAddresses: (attrs.match(/https:\\/\\/127\\.0\\.0\\.1:\\d+\\//g) ?? []).length,
          computed: way ? d.defaultView.getComputedStyle(way).backgroundImage : null,
          images: d.querySelectorAll('img').length,
        };
      })()`);
      assert.equal(material.removed, "0", "the cleaning must be off for this test");
      assert.ok(material.cssNamesAddresses >= Object.keys(ESCAPE_CSS_WAYS).length - 2, `the CSS names ${material.cssNamesAddresses} addresses`);
      assert.ok(material.attributeAddresses >= 3, `the attributes name ${material.attributeAddresses} addresses`);
      assert.match(material.computed, /https:\/\/127\.0\.0\.1:/);
      assert.ok(material.images >= 1);

      // The engine makes its nodes with the frame's document, never the page's: an element that starts loading when
      // its attribute is set would otherwise do so under the page's policy (https images allowed) before it reached
      // the frame. Counted over a second render (F5): not one node is made by the page's document.
      await app.eval(`(() => {
        const made = (window.__made = { page: 0, frame: 0 });
        const patch = (proto, label) => {
          for (const name of ['createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment', 'createComment']) {
            const original = proto[name];
            proto[name] = function (...args) { made[label]++; return original.apply(this, args); };
          }
        };
        patch(Document.prototype, 'page');
        patch(${ROOT}.defaultView.Document.prototype, 'frame');
        ${ROOT}.querySelector('.docx-wrapper').setAttribute('data-probe', '1');
      })()`);
      await app.key("F5");
      await app.waitFor(`!${ROOT}.querySelector('.docx-wrapper[data-probe]') && ${shows("Escape document text")}`, 15000);
      const made = await app.eval(`window.__made`);
      assert.equal(made.page, 0, "a node was made by the page's document");
      assert.ok(made.frame > 100, `the frame's document made ${made.frame} nodes`);
      // What a cleaner that missed something would leave in the frame: elements, put into the live document.
      await app.eval(`(() => {
        const d = ${ROOT};
        const html = ${JSON.stringify(Object.values(ELEMENT_WAYS).map((make) => make(at)))}.join('');
        d.getElementById('host').insertAdjacentHTML('beforeend', html);
        d.getElementById('ping')?.click();
        d.getElementById('form')?.requestSubmit?.();
      })()`);
      await sleep(3000);
      assert.deepEqual(contacted(), [], "the frame let a request through");
      assert.ok(app.stderr().includes(`[navigation] cancelled frame navigation to ${at("elIframe")}`), "the guard cancelled the nested frame's navigation");
      // Still the same document: nothing navigated it (the refresh and the form went nowhere).
      assert.equal(await app.eval(`${FRAME}.contentWindow.location.href`), "about:srcdoc");

      // The control: the same material in a frame without a policy of its own (the page's policy still applies,
      // which allows https images) is fetched, so the listeners do see what a leak looks like.
      await app.eval(`(() => {
        const d = ${ROOT};
        const control = document.createElement('iframe');
        control.id = 'control';
        control.setAttribute('sandbox', 'allow-same-origin');
        control.style.cssText = 'position:fixed;left:-5000px;top:0;width:800px;height:600px';
        const styles = [...d.head.querySelectorAll('style')].map((s) => s.outerHTML).join('');
        control.srcdoc = '<!doctype html><html><head>' + styles + '</head><body>' + d.body.innerHTML + '</body></html>';
        document.body.append(control);
      })()`);
      const expected = ["background", "imageSetVar", "borderImage", "listStyle", "content", "elImg", "elStyleAttr"];
      try {
        for (let i = 0; i < 100 && !expected.every((n) => listeners[n].hits.length > 0); i++) await sleep(100);
      } finally {
        await app.eval(`document.getElementById('control')?.remove()`);
      }
      const missing = expected.filter((n) => listeners[n].hits.length === 0);
      assert.deepEqual(missing, [], "the control frame should have fetched these: the test could not see a leak otherwise");
    });
  } finally {
    for (const { server } of Object.values(listeners)) server.close();
  }
});

test("the frame never navigates, whatever the document or the page asks for", async () => {
  const doc = put("frame-nav.docx", await makeDocx({ pages: 2 }));
  await session({ port: 9446, paths: [doc] }, async (app) => {
    await app.waitFor(shows("Kladde viewer test document"), 20000);
    await app.eval(`window.__fdoc = ${ROOT}; window.__marker = 1`);
    const still = async (what) => {
      const state = await app.eval(`(() => {
        const f = ${FRAME};
        return { href: f.contentWindow.location.href, sameDocument: f.contentDocument === window.__fdoc, text: !!f.contentDocument.querySelector('.docx-wrapper'), page: window.__marker === 1 && !!document.querySelector('.tabbar') };
      })()`);
      assert.deepEqual(state, { href: "about:srcdoc", sameDocument: true, text: true, page: true }, what);
    };

    // The page's own policy allows these targets (the same origin, `about:`), and so does the sandbox: only the
    // frame navigation guard of the app stands in the way.
    const targets = ["about:blank", "http://tauri.localhost/index.html", "http://tauri.localhost/other.html"];
    for (const target of targets) {
      await app.eval(`${FRAME}.contentWindow.location.assign(${JSON.stringify(target)})`);
      await sleep(800);
      await still(`after location.assign(${target})`);
    }
    // A refresh the document would have to ask for itself (a `<meta>` is not something the engine makes).
    await app.eval(`(() => {
      const d = ${ROOT};
      const meta = d.createElement('meta');
      meta.httpEquiv = 'refresh';
      meta.content = '0;url=http://tauri.localhost/index.html';
      d.head.append(meta);
    })()`);
    await sleep(1200);
    await still("after a meta refresh");
    // The guard says so (it is Kladde's, not the browser's policy).
    const stderr = app.stderr();
    for (const target of targets) {
      assert.ok(stderr.includes(`[navigation] cancelled frame navigation to ${target}`), `the guard did not log ${target}: ${stderr.slice(-600)}`);
    }
    // And the frame still works as before: a key reaches Kladde from it.
    await app.waitFor(FOCUSED);
    await app.key("Ctrl+Shift+P");
    assert.equal(await app.eval(`!!document.querySelector('.picker')`), true);
  });
});

test("the frame follows the theme, also when it changes while the document is shown", async () => {
  const doc = put("themed.docx", await makeTrackedDocx());
  await session({ port: 9447, paths: [doc], settings: { theme: "latte" } }, async (app) => {
    await app.waitFor(shows("Commented words"), 20000);
    const names = ["--bg-alt", "--fg-dim", "--paper", "--paper-text", "--paper-insert", "--paper-delete"];
    const look = () =>
      app.eval(`(() => {
        const d = ${ROOT};
        const page = getComputedStyle(document.documentElement);
        const inner = d.defaultView.getComputedStyle(d.documentElement);
        const color = (el) => d.defaultView.getComputedStyle(el);
        return {
          same: ${JSON.stringify(names)}.map((n) => [n, page.getPropertyValue(n).trim(), inner.getPropertyValue(n).trim()]),
          desk: inner.backgroundColor,
          appDesk: getComputedStyle(${VIEW}).backgroundColor,
          paper: color(d.querySelector('section.docx')).backgroundColor,
          insert: color(d.querySelector('ins span')).color,
        };
      })()`);
    const latte = await look();
    for (const [name, outer, inner] of latte.same) {
      assert.ok(outer, `${name} is set in the app`);
      assert.equal(inner, outer, name);
    }
    assert.equal(latte.desk, latte.appDesk);

    // A flavor change and a live-edited theme.css both end in this event.
    await app.eval(`(() => {
      document.documentElement.dataset.theme = 'mocha';
      document.documentElement.style.setProperty('--paper', 'rgb(255, 251, 230)');
      document.documentElement.style.setProperty('--paper-insert', 'rgb(1, 2, 3)');
      window.dispatchEvent(new Event('kladde-theme'));
    })()`);
    const mocha = await look();
    for (const [name, outer, inner] of mocha.same) assert.equal(inner, outer, name);
    assert.equal(mocha.desk, mocha.appDesk);
    assert.notEqual(mocha.desk, latte.desk, "the desk changed with the flavor");
    assert.equal(mocha.paper, "rgb(255, 251, 230)");
    assert.equal(mocha.insert, "rgb(1, 2, 3)");

    // Closing the tab takes the frame (and with it the comment ranges) away; the page's registry never had them.
    await app.waitFor(FOCUSED);
    await app.key("Ctrl+W");
    await app.waitFor(`!document.querySelector('.document-view')`);
    assert.equal(await app.eval(`CSS.highlights.has('docx-comments')`), false);
  });
});
