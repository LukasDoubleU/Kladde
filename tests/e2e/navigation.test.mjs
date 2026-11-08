// The window can never be navigated away from Kladde: forms and buttons in the Markdown preview, a navigation
// the page starts itself, new windows, the context menu, and what the asset protocol serves. Needs a debug build:
//   npx tauri build --debug --no-bundle && npm run test:e2e
//
// Nothing here touches the desktop: external links go to a log file (KLADDE_OPEN_URL_LOG, isolated profile
// only) instead of the browser, and the context menu is tested with synthetic `contextmenu` events, which never
// open WebView2's native menu.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { launch, removeProfile, tempProfile, writeFixture } from "./kladde.mjs";

const profile = tempProfile("kladde-navigation");
after(() => removeProfile(profile));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>';

/** Starts Kladde with files open and an external link log; `body(app, urls)` gets a function returning the logged URLs. */
async function session({ port, files, active }, body) {
  const dir = tempProfile("kladde-navigation-run");
  const log = join(dir, "urls.log");
  const app = await launch({ port, profile: dir, files, env: { KLADDE_OPEN_URL_LOG: log } });
  try {
    await app.waitFor(`document.querySelector('.tab.active .title')?.textContent === ${JSON.stringify(active)}`, 15000);
    await body(app, () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []), dir);
  } finally {
    await app.kill();
    await removeProfile(dir);
  }
}

/** Evaluates with a user gesture, which window.open needs to get past the popup blocker. */
const gesture = (app, expression) =>
  app.cdp.send("Runtime.evaluate", { expression, userGesture: true, awaitPromise: true, returnByValue: true });

/** A second DevTools connection that records the answers of the asset protocol (and everything else loaded). */
async function watchResponses(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  const responses = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === "Network.responseReceived") {
      const { url, status, mimeType } = msg.params.response;
      responses.push({ url, status, type: mimeType });
    }
  };
  ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  return { responses, close: () => ws.close() };
}

/** Waits until the log has the URL: the navigations before it were decided by then (they run in order). */
async function logged(app, urls, url) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (urls().includes(url)) return;
    await sleep(50);
  }
  assert.fail(`${url} did not reach the log: ${JSON.stringify(urls())}`);
}

const FORMS = `# Forms stay out

Before.

<form id="f1" action="https://example.invalid/steal" method="post">
<input name="q" value="x">
<button type="submit" id="go">Send</button>
</form>

<form action="https://example.invalid/get"><button formaction="https://example.invalid/other" type="submit">Click me</button></form>

<select><option>a</option></select> <textarea>t</textarea> <input type="checkbox" checked> <button>plain</button>

<meta http-equiv="refresh" content="0;url=https://example.invalid/meta">
<iframe src="https://example.invalid/frame"></iframe>
<object data="https://example.invalid/object"></object>

- [ ] open task
- [x] done task
- plain item

After the forms.
`;

test("a form and its controls in Markdown do not survive the sanitizer, and task lists still render", async () => {
  const forms = writeFixture(profile, "forms.md", FORMS);
  const other = writeFixture(profile, "other.md", "# Other\n");
  await session({ port: 9420, files: [other, forms], active: "forms.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown h1')");
    const found = await app.eval(`({
      controls: document.querySelectorAll('.markdown form, .markdown input, .markdown button, .markdown select, .markdown textarea, .markdown option').length,
      embeds: document.querySelectorAll('.markdown meta, .markdown iframe, .markdown object, .markdown embed, .markdown link, .markdown base').length,
      formaction: document.querySelectorAll('.markdown [formaction]').length,
      text: document.querySelector('.markdown').innerText.includes('After the forms.'),
      boxes: [...document.querySelectorAll('.markdown li.task-list-item .task-box')].map((b) => b.getAttribute('aria-checked')),
      boxSize: (() => { const b = document.querySelector('.markdown .task-box').getBoundingClientRect(); return [b.width, b.height]; })(),
      plain: document.querySelectorAll('.markdown li:not(.task-list-item)').length,
    })`);
    assert.equal(found.controls, 0);
    assert.equal(found.embeds, 0);
    assert.equal(found.formaction, 0);
    assert.ok(found.text);
    assert.deepEqual(found.boxes, ["false", "true"]);
    assert.ok(found.boxSize[0] > 4 && found.boxSize[1] > 4, `the task box has a size: ${found.boxSize}`);
    assert.equal(found.plain, 1);
    // Nothing was opened, and the UI is as it was.
    assert.deepEqual(urls(), []);
    assert.deepEqual((await app.state()).tabs, ["other.md", "forms.md"]);
  });
});

test("a form that bypasses the sanitizer (injected into the page) cannot navigate: the CSP forbids the submission", async () => {
  const forms = writeFixture(profile, "forms2.md", "# Injected\n\nText.\n");
  await session({ port: 9421, files: [forms], active: "forms2.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown h1')");
    await app.eval(`(() => {
      window.__marker = "still the same page";
      window.__violations = [];
      document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective));
      const host = document.createElement("div");
      host.innerHTML = '<form action="https://example.invalid/steal" method="post"><input name="q"><button id="injected-go" type="submit">Go</button></form>' +
        '<form action="https://example.invalid/post" method="post"><button id="injected-fa" type="submit" formaction="https://example.invalid/other">Go</button></form>';
      document.body.append(host);
    })()`);
    await app.eval("document.getElementById('injected-go').click()");
    await app.eval("document.getElementById('injected-fa').click()");
    await app.waitFor("window.__violations.length >= 2");
    assert.deepEqual(await app.eval("window.__violations.slice(0, 2)"), ["form-action", "form-action"]);
    await sleep(500);
    assert.equal(await app.eval("window.__marker"), "still the same page");
    assert.equal(await app.eval("document.querySelectorAll('.tab').length"), 1);
    assert.deepEqual(urls(), []);
  });
});

test("the page cannot be navigated to another origin: web links go to the system, everything else is cancelled", async () => {
  const doc = writeFixture(profile, "guard.md", "# Guard\n\nText.\n");
  const html = writeFixture(profile, "page.pdf", "<!doctype html><html><body><h1>A page</h1><script>document.title='ran'</script></body></html>");
  await session({ port: 9422, files: [doc], active: "guard.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.cm-line')");
    // Unsaved typing is what a lost window would cost.
    await app.eval("document.querySelector('.cm-content').focus()");
    await app.type("typed but not saved ");
    await app.waitFor("document.querySelector('.tab.active')?.classList.contains('dirty')");
    const before = await app.state();
    await app.eval(`window.__marker = "same page"; window.__origin = location.origin`);
    const origin = await app.eval("location.origin");
    assert.match(origin, /^(http:\/\/tauri\.localhost|tauri:\/\/localhost)$/, "the origin of a debug build");
    const asset = await app.eval(`window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(html)})`);

    // From the page itself, as a script or devtools would.
    await app.eval(`location.assign("file:///C:/kladde-navigation-test-nothing-here.html")`);
    await app.eval(`location.href = "foo-app:open"`);
    await app.eval(`location.assign(${JSON.stringify(asset)})`);
    await app.eval(`location.assign("http://asset.localhost/C%3A%2Fkladde%2Fx.pdf")`);
    await app.eval(`location.replace("http://ipc.localhost/anything")`);
    await app.eval(`location.assign("data:text/html,<h1>data</h1>")`);
    // From outside, through the DevTools protocol (the same NavigationStarting decides).
    await app.cdp.send("Page.navigate", { url: "file:///C:/kladde-navigation-test-nothing-here-either.html" }).catch(() => {});
    await app.cdp.send("Page.navigate", { url: asset }).catch(() => {});
    // A web link is cancelled in the window and handed to the system instead.
    await app.eval(`location.assign("https://example.invalid/page?a=1")`);
    await logged(app, urls, "https://example.invalid/page?a=1");
    await app.cdp.send("Page.navigate", { url: "mailto:me@example.invalid" }).catch(() => {});
    await logged(app, urls, "mailto:me@example.invalid");
    await sleep(500);

    assert.equal(await app.eval("window.__marker"), "same page", "the page was not replaced");
    assert.equal(await app.eval("location.origin"), origin);
    assert.equal(await app.eval("document.title"), "Kladde");
    assert.deepEqual(await app.state(), before, "tabs, text and the unsaved edit are as before");
    // Only the two web/mail links were handed over; the asset, file, ipc, data and unknown-scheme ones were not.
    assert.deepEqual(urls(), ["https://example.invalid/page?a=1", "mailto:me@example.invalid"]);
  });
});

test("a new window request (window.open, target=_blank) is denied; web links go to the system", async () => {
  const doc = writeFixture(profile, "windows.md", "# Windows\n\nText.\n");
  await session({ port: 9423, files: [doc], active: "windows.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown h1')");
    await app.eval(`window.__marker = "same page"`);
    await gesture(app, `window.open("file:///C:/kladde-navigation-test-nothing-here.html")`);
    await gesture(app, `window.open("foo-app:open")`);
    await gesture(app, `window.open("http://tauri.localhost/")`);
    await gesture(app, `window.open("https://example.invalid/new-window")`);
    await logged(app, urls, "https://example.invalid/new-window");
    // A link that asks for a new window, clicked by script.
    await gesture(app, `(() => { const a = document.createElement("a"); a.href = "https://example.invalid/blank"; a.target = "_blank"; document.body.append(a); a.click(); a.remove(); })()`);
    await logged(app, urls, "https://example.invalid/blank");
    await sleep(300);
    assert.equal(await app.eval("window.__marker"), "same page");
    assert.deepEqual(urls(), ["https://example.invalid/new-window", "https://example.invalid/blank"]);
    // Only the one page: no second WebView2 target besides the main page was opened.
    const targets = await (await fetch("http://127.0.0.1:9423/json")).json();
    assert.equal(targets.filter((t) => t.type === "page").length, 1);
  });
});

/** Dispatches a contextmenu event on the first element matching the selector; true when the default menu would show. */
const contextmenu = (app, selector) =>
  app.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const box = el.getBoundingClientRect();
    return el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5 }));
  })()`);

test("WebView2's default menu (Refresh, Back) is only left where text is typed; a selection gets a Copy menu of its own", async () => {
  const doc = writeFixture(profile, "menu.md", "# Menu\n\nSome text to select in the preview.\n");
  await session({ port: 9424, files: [doc], active: "menu.md" }, async (app) => {
    await app.waitFor("!!document.querySelector('.markdown p')");
    await app.waitFor("!!document.querySelector('.cm-line')");
    // Where the user types, the native menu (Cut, Copy, Paste) stays.
    assert.equal(await contextmenu(app, ".cm-content"), true, "editor keeps the native menu");
    // Everywhere else it would have Refresh and Back: prevented.
    for (const selector of [".markdown p", ".markdown h1", ".preview", ".tab", "footer", ".app"]) {
      assert.equal(await contextmenu(app, selector), false, `${selector} has no native menu`);
    }
    // The tab bar's own menu opened for ".tab" above.
    assert.equal(await app.eval("document.querySelector('.menu button')?.textContent"), "Close");
    await app.key("Escape");
    await app.waitFor("!document.querySelector('.menu')");
    // A read-only text field is not typed into either.
    await app.eval(`(() => { const i = document.createElement("input"); i.id = "ro"; i.readOnly = true; i.value = "abc"; document.body.append(i); const t = document.createElement("input"); t.id = "rw"; document.body.append(t); const c = document.createElement("input"); c.id = "cb"; c.type = "checkbox"; document.body.append(c); })()`);
    assert.equal(await contextmenu(app, "#ro"), false);
    assert.equal(await contextmenu(app, "#cb"), false);
    assert.equal(await contextmenu(app, "#rw"), true);

    // Without a selection no menu of ours either.
    await app.eval("getSelection().removeAllRanges()");
    await contextmenu(app, ".markdown p");
    assert.equal(await app.eval("!!document.querySelector('.menu')"), false);

    // With a selection: Copy, and it copies exactly the selection.
    await app.eval(`(() => {
      window.__copied = null;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => ((window.__copied = t), Promise.resolve()) }, configurable: true });
      const p = document.querySelector('.markdown p');
      getSelection().selectAllChildren(p);
    })()`);
    assert.equal(await contextmenu(app, ".markdown p"), false);
    await app.waitFor("!!document.querySelector('.menu')");
    assert.deepEqual(await app.eval("[...document.querySelectorAll('.menu button')].map((b) => b.textContent)"), ["Copy"]);
    await app.eval("document.querySelector('.menu button').click()");
    await app.waitFor("window.__copied !== null");
    assert.equal(await app.eval("window.__copied"), "Some text to select in the preview.");
    await app.waitFor("!document.querySelector('.menu')");
  });
});

test("images load through the asset protocol after the scope was narrowed, whatever the case of the extension", async () => {
  const dir = join(profile, "images");
  mkdirSync(join(dir, "Sub Folder"), { recursive: true });
  mkdirSync(join(dir, ".hidden"), { recursive: true });
  for (const name of ["lower.png", "PHOTO.PNG", "Mixed.PnG", "Sub Folder/ümlaut.jpg", ".hidden/dot.png", "UPPER.JPG", "anim.gif"]) writeFileSync(join(dir, name), PNG);
  writeFileSync(join(dir, "plain.svg"), SVG);
  const doc = writeFixture(
    dir,
    "doc.md",
    [
      "# Pictures",
      "",
      "![a](lower.png) ![b](PHOTO.PNG) ![c](Mixed.PnG) ![d](Sub%20Folder/%C3%BCmlaut.jpg)",
      "",
      "![e](.hidden/dot.png) ![f](UPPER.JPG) ![g](plain.svg) ![h](anim.gif)",
    ].join("\n"),
  );
  const files = [join(dir, "lower.png"), join(dir, "PHOTO.PNG"), join(dir, "UPPER.JPG"), doc];
  await session({ port: 9425, files, active: "doc.md" }, async (app) => {
    // Preview images.
    await app.waitFor("document.querySelectorAll('.markdown img').length === 8");
    await app.waitFor("[...document.querySelectorAll('.markdown img')].every((i) => i.complete)", 15000);
    const images = await app.eval(
      "[...document.querySelectorAll('.markdown img')].map((i) => ({ alt: i.alt, w: i.naturalWidth, src: i.src }))",
    );
    for (const image of images) {
      assert.ok(image.w > 0, `image ${image.alt} loaded (${image.src})`);
      assert.match(image.src, /^http:\/\/asset\.localhost\//, "through the asset protocol");
    }
    // Image tabs: lower and upper case extensions.
    for (const name of ["lower.png", "PHOTO.PNG", "UPPER.JPG"]) {
      for (let i = 0; i < 6 && (await app.state()).active !== name; i++) await app.key("Ctrl+Tab");
      assert.equal((await app.state()).active, name);
      await app.waitFor("(() => { const i = document.querySelector('.image-view img'); return !!i && i.complete && i.naturalWidth === 1; })()", 8000);
    }
  });
});

test("the asset protocol refuses an HTML file named .pdf or .txt, and only serves images", async () => {
  const dir = join(profile, "assets");
  mkdirSync(dir, { recursive: true });
  const page = "<!doctype html><html><body><h1>Live page</h1></body></html>";
  const files = {
    "evil.pdf": page,
    "EVIL.PDF": page,
    "evil.txt": page,
    "evil.html": page,
    "evil.htm": page,
    "evil.xhtml": page,
    "evil": page,
    "evil.pdf.exe": page,
    "settings.json": "{}",
    "script.js": "alert(1)",
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "ok.png"), PNG);
  writeFileSync(join(dir, "OK.PNG"), PNG);
  const doc = writeFixture(dir, "doc.md", "# Assets\n");
  await session({ port: 9426, files: [doc], active: "doc.md" }, async (app) => {
    await app.waitFor("!!document.querySelector('.markdown h1')");
    // What the protocol answers is read from the network events of a second DevTools connection (the page's CSP
    // would stop a fetch of this test, and an <img> only tells "image" from "no image").
    const watch = await watchResponses(9426);
    let n = 0;
    const probe = async (path) => {
      const tag = `probe=${++n}`;
      await app.eval(`new Promise((done) => { const i = new Image(); i.onload = i.onerror = () => done(); i.src = window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(path)}) + "?${tag}"; })`);
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const hit = watch.responses.find((r) => r.url.endsWith(`?${tag}`));
        if (hit) return hit;
        await sleep(50);
      }
      assert.fail(`no response seen for ${path}`);
    };
    for (const name of Object.keys(files)) {
      const answer = await probe(join(dir, name));
      assert.equal(answer.status, 403, `${name} is refused: ${JSON.stringify(answer)}`);
          }
    for (const name of ["ok.png", "OK.PNG"]) {
      const answer = await probe(join(dir, name));
      assert.deepEqual([answer.status, answer.type], [200, "image/png"], name);
    }
    // A path that tries to leave through ..: the file is not an image either.
    assert.equal((await probe(join(dir, "..", "assets", "evil.pdf"))).status, 403);
    watch.close();
  });
});

const GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** A real left click (DevTools input events, like a user's) at a point of the page. */
async function realClick(app, { x, y }) {
  const send = (type) => app.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  await send("mouseMoved");
  await send("mousePressed");
  await send("mouseReleased");
  await sleep(300);
}

const center = (app, selector) =>
  app.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

test("an image map in Markdown is dropped by the sanitizer, and clicking its picture cannot navigate or reload Kladde", async () => {
  const md = writeFixture(
    profile,
    "map.md",
    [
      "# Map",
      "",
      `<img id="m1" src="${GIF}" width="300" height="100" usemap="#m"><map name="m">`,
      `<area shape="rect" coords="0,0,100,100" href="">`,
      `<area shape="rect" coords="100,0,200,100" href="other.md">`,
      `<area shape="rect" coords="200,0,300,100" href="http://xn--a.invalid/">`,
      "</map>",
      "",
      "After.",
    ].join("\n"),
  );
  await session({ port: 9441, files: [md], active: "map.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown #m1')");
    assert.equal(await app.eval("document.querySelectorAll('.markdown map, .markdown area, .markdown [usemap]').length"), 0);
    // Unsaved typing is what a reload would cost.
    await app.eval("document.querySelector('.cm-content').focus()");
    await app.type("UNSAVED-WORDS ");
    await app.waitFor("document.querySelector('.tab.active')?.classList.contains('dirty')");
    const before = await app.state();
    await app.eval(`window.__marker = "same page"`);
    for (const dx of [-100, 0, 100]) {
      const { x, y } = await center(app, ".markdown #m1");
      await realClick(app, { x: x + dx, y });
    }
    assert.equal(await app.eval("window.__marker"), "same page");
    assert.deepEqual(await app.state(), before, "tabs, text and the unsaved edit are as before");
    assert.deepEqual(urls(), []);
  });
});

test("an <area> that gets into the page anyway cannot reload Kladde or load an unparseable address: the guard cancels it", async () => {
  const md = writeFixture(profile, "area.md", "# Area\n\nText.\n");
  await session({ port: 9442, files: [md], active: "area.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown h1')");
    await app.eval("document.querySelector('.cm-content').focus()");
    await app.type("UNSAVED-WORDS ");
    await app.waitFor("document.querySelector('.tab.active')?.classList.contains('dirty')");
    const before = await app.state();
    await app.eval(`window.__marker = "same page"`);
    // An image map outside of the preview, so not even its click handler is in the way. Tauri answers every path of
    // its origin with index.html, so each of these used to start the app again (or leave it for an error page).
    for (const href of ["", "/", "other.md", "?x", "http://tauri.localhost/index.html", "http://xn--a.invalid/", "http://xn--a.example.com/x"]) {
      await app.eval(`(() => {
        document.getElementById("injected-map")?.remove();
        const host = document.createElement("div");
        host.id = "injected-map";
        host.innerHTML = '<img id="injected-img" src="${GIF}" width="200" height="200" usemap="#injected" style="position:fixed;left:40px;top:40px;z-index:99999"><map name="injected"><area shape="rect" coords="0,0,200,200" href=' + ${JSON.stringify(JSON.stringify(href))} + '></map>';
        document.body.append(host);
      })()`);
      await app.waitFor("document.getElementById('injected-img')?.complete");
      await realClick(app, await center(app, "#injected-img"));
      await sleep(200);
      assert.equal(await app.eval("window.__marker"), "same page", `area href=${JSON.stringify(href)}`);
    }
    // The same from a script or devtools, which is what Tauri's callback lets through for an address it cannot parse.
    for (const target of ["http://xn--a.invalid/", "/", "index.html", "?x", "http://tauri.localhost/other.md", "tauri://localhost/"]) {
      await app.eval(`location.assign(${JSON.stringify(target)})`);
      await sleep(200);
      assert.equal(await app.eval("window.__marker"), "same page", `location.assign(${JSON.stringify(target)})`);
    }
    await app.eval("location.reload()");
    await app.cdp.send("Page.reload").catch(() => {});
    await app.cdp.send("Page.navigate", { url: "http://xn--a.invalid/" }).catch(() => {});
    await sleep(500);
    assert.equal(await app.eval("window.__marker"), "same page", "no reload");
    assert.match(await app.eval("location.href"), /^(http:\/\/tauri\.localhost|tauri:\/\/localhost)\/$/);
    assert.deepEqual(await app.state(), before, "tabs, text and the unsaved edit are as before");
    assert.deepEqual(urls(), [], "none of it went to the system");
  });
});

test("a Mermaid diagram cannot carry a form either: the SVG is stripped like the Markdown", async () => {
  const md = writeFixture(
    profile,
    "mermaid-form.md",
    [
      "# Diagram",
      "",
      "```mermaid",
      "flowchart LR",
      `  A["<form action='https://example.invalid/m' method='post'><input name='q' value='v'><button type='submit'>Go</button></form>"] --> B[Plain]`,
      "```",
    ].join("\n"),
  );
  await session({ port: 9443, files: [md], active: "mermaid-form.md" }, async (app, urls) => {
    await app.waitFor("!!document.querySelector('.markdown .mermaid-block svg')", 20000);
    const found = await app.eval(`({
      controls: document.querySelectorAll('.markdown form, .markdown input, .markdown button, .markdown [formaction]').length,
      text: document.querySelector('.markdown .mermaid-block svg').textContent.includes('Plain'),
    })`);
    assert.equal(found.controls, 0);
    assert.ok(found.text, "the diagram itself is drawn");
    assert.deepEqual(urls(), []);
  });
});

test("Copy in the own menu takes the selection from the editor, not from the lines CodeMirror happened to render", async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line number ${i}`);
  const text = lines.join("\n") + "\n";
  const doc = writeFixture(profile, "long.txt", text);
  await session({ port: 9444, files: [doc], active: "long.txt" }, async (app) => {
    await app.waitFor("!!document.querySelector('.cm-gutterElement')");
    await app.eval("document.querySelector('.cm-content').focus()");
    await app.key("Ctrl+A");
    await app.eval(`(() => {
      window.__copied = null;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => ((window.__copied = t), Promise.resolve()) }, configurable: true });
    })()`);
    // The gutter has no native menu (it is no text field); the selection is the editor's, 3000 lines of it.
    assert.equal(await contextmenu(app, ".cm-gutterElement"), false);
    await app.waitFor("!!document.querySelector('.menu')");
    assert.deepEqual(await app.eval("[...document.querySelectorAll('.menu button')].map((b) => b.textContent)"), ["Copy"]);
    await app.eval("document.querySelector('.menu button').click()");
    await app.waitFor("window.__copied !== null");
    assert.equal(await app.eval("window.__copied"), text);
    // Nothing selected: no menu at all.
    await app.eval("document.querySelector('.cm-content').focus()");
    await app.key("Ctrl+Home");
    assert.equal(await contextmenu(app, ".cm-gutterElement"), false);
    assert.equal(await app.eval("!!document.querySelector('.menu')"), false);
  });
});
