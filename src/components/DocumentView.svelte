<script lang="ts" module>
  // The engine renders on the page's global state (it registers the comment ranges in `CSS.highlights` under one
  // name), so two renders at the same time, from two document tabs, could take each other's highlight. One at a time.
  let renderChain: Promise<unknown> = Promise.resolve();
  function inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = renderChain.then(job);
    renderChain = run.catch(() => {});
    return run;
  }
</script>

<script lang="ts">
  // Read-only viewer of a document tab (kind "document"): Word documents today, with docx-preview as the engine.
  // Loaded on first use together with its engine (dynamic imports), kept alive while its tab is hidden.
  //
  // The document is untrusted and is shown in a frame of its own: a sandboxed `srcdoc` iframe whose document has a
  // CSP that allows nothing but `data:` images and fonts (`FRAME_CSP`), so "a document cannot make a request" holds
  // by construction, whatever the document's CSS or SVG says. The engine builds the DOM element by element (no HTML
  // parsing), with the frame's own document (`makeH`: its default makes nodes with the page's, where an element that
  // starts loading when its attribute is set would be held only by the page's policy, which allows https images), and
  // `cleanDocumentNodes` still removes everything that could fetch another resource before the nodes are attached to
  // the frame's tree: a second layer, which also keeps the DOM small. The frame is Kladde's to drive (same
  // origin): the page puts listeners on its window and document and bridges what Kladde needs from there (keys,
  // wheel, mouse buttons, context menu, links, theme). See docs/architecture.md.
  //
  // The frame scrolls itself (its document is the scroller, the iframe fills the pane) instead of being as tall as
  // its content inside a scroll pane of the page: then the browser's own keyboard scrolling (arrows, PageUp/Down,
  // Home/End, Space) works with the focus in the document without any forwarding, and the frame clips whatever the
  // document positions (fixed or absolute shapes) to its box.
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { api, type DocumentReadError } from "../lib/api";
  import { writeText } from "../lib/clipboard";
  import { cleanDocumentNodes } from "../lib/document-clean";
  import {
    containerOf,
    corruptProblem,
    fitScale,
    FRAME_HOST_ID,
    FRAME_SANDBOX,
    FRAME_VARIABLES,
    frameSrcdoc,
    isSelectAll,
    keyboardInit,
    makeH,
    mouseInit,
    pageCountOf,
    problemFor,
    tooLargeProblem,
    wheelInit,
    zoomFactor,
    type DocumentProblem,
  } from "../lib/documents";
  import { dirname } from "../lib/links";
  import { integration } from "../lib/integration.svelte";
  import { settings } from "../lib/settings.svelte";
  import { keyCapture } from "../lib/shortcut-editor.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";

  let { tab, active }: { tab: Tab; active: boolean } = $props();

  // Changes the user can see are shown as such: insertions underlined, deletions struck through, both colored, and
  // comments as a marker with the text on hover. Hiding them would show a text that is not what the file says
  // (docx-preview's default shows insertions as plain text and drops deletions and comments).
  // Alternative chunks (raw HTML inside the file, shown in an iframe) are never rendered. Images and fonts become
  // data: URLs, which the frame's CSP allows.
  const OPTIONS = {
    className: "docx",
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderAltChunks: false,
    renderChanges: true,
    renderComments: true,
    experimental: false,
    useBase64URL: true,
  };

  // The name the engine registers its comment ranges under (`<className>-comments`).
  const COMMENTS = "docx-comments";

  // After the document's own styles (same specificity, later wins): white pages on the themed desk, links that
  // look like links, markers for tracked changes. The variables are the frame's own copies of the app's (see
  // `syncTheme`): they do not inherit into an iframe.
  const OVERRIDES = `
.docx-wrapper { background: transparent; padding: 24px 24px 0; }
.docx-wrapper > section.docx { background: var(--paper); box-shadow: 0 1px 8px rgb(0 0 0 / 0.45); margin-bottom: 24px; }
.docx { color: var(--paper-text); }
.docx a[href] { cursor: pointer; }
.docx a[href]:hover { text-decoration: underline; }
.docx ins, .docx ins * { color: var(--paper-insert) !important; text-decoration: underline; }
.docx del, .docx del * { color: var(--paper-delete) !important; text-decoration: line-through; }
.docx-comment-ref { cursor: default; }
`;

  // A file that is being saved (Word writes in steps, or replaces the file) is read again before an error shows.
  const RETRY_AFTER = [300, 600, 1200, 2400];
  const RELOAD_DEBOUNCE = 300;

  let frame: HTMLIFrameElement;
  let problemBox: HTMLDivElement | undefined = $state();
  // The frame's document, window and host element (plain fields: they are not state, and a frame is not reactive).
  let fdoc: Document | null = null;
  let fwin: (Window & { CSS: typeof CSS }) | null = null;
  let host: HTMLElement | null = null;
  // Resolves true when the frame's document is ready, false when it never will be (the viewer was closed first, or the
  // frame did not load in time): whoever waits for the frame has to leave then, with what it holds.
  let markReady: (loaded: boolean) => void = () => {};
  const frameReady = new Promise<boolean>((resolve) => (markReady = resolve));
  const FRAME_TIMEOUT = 10_000;
  const startProblem: DocumentProblem = { kind: "unreadable", message: "The viewer could not start. Close the tab and open the document again." };
  let problem = $state<DocumentProblem | null>(null);
  let loading = $state(true);
  let rendered = false;
  let generation = 0;
  let timer = 0;
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Layout: the pages' width at scale 1, the scale now, the scroll position in px at that scale.
  let natural = 0;
  let needsMeasure = false;
  let measured = false;
  let scale = 1;
  let savedTop = 0;
  let userFactor = 1;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The viewport of the frame's document: both are 0 while the tab is hidden. Asked of the iframe element, whose box
  // is gone then: the frame's own document keeps reporting its last size for a while (and its scroll position
  // resets), so reading it would take that reset for the user's scrolling.
  const viewWidth = () => (frame.clientHeight > 0 ? (fdoc?.documentElement.clientWidth ?? 0) : 0);
  const viewHeight = () => (frame.clientHeight > 0 ? (fdoc?.documentElement.clientHeight ?? 0) : 0);
  const scroller = () => fdoc?.scrollingElement ?? null;

  type Outcome =
    | { ok: true; nodes: Node[]; highlight: Highlight | null; pages: number | null; removed: number }
    | { ok: false; problem: DocumentProblem; transient: boolean };

  // Test hook (isolated profile only, see `document_no_clean` in lib.rs): without the cleaning, to prove that the
  // frame alone keeps the network out.
  let noClean: Promise<boolean> | null = null;
  const skipCleaning = () => (noClean ??= api.documentNoClean().catch(() => false));

  /** One try to read and render. `again`: there is a rendering to keep, so failures that a save in progress causes are expected. */
  async function attempt(again: boolean): Promise<Outcome> {
    // The frame first: a render needs it, and the file's bytes (up to 50 MB) are not held while waiting for it.
    if (!(await frameReady)) return { ok: false, problem: startProblem, transient: false };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await api.readDocument(tab.path!));
    } catch (e) {
      const error = e as DocumentReadError;
      if (error?.kind === "tooLarge") return { ok: false, problem: tooLargeProblem(error.size), transient: false };
      return {
        ok: false,
        problem: { kind: "unreadable", message: `The file could not be read: ${error?.message ?? e}` },
        transient: error?.kind === "busy" || (again && error?.kind === "notFound"),
      };
    }
    const bad = problemFor(containerOf(bytes));
    if (bad) return { ok: false, problem: bad, transient: again };
    try {
      const { parseAsync, renderDocument } = await import("docx-preview");
      const parsed = await parseAsync(bytes, OPTIONS);
      // The engine makes its nodes with the frame's document (`makeH`), so they are born under the frame's policy: an
      // element that starts loading when its attribute is set, detached or not, is held by it.
      const doc = fdoc;
      if (!doc) throw new Error("the viewer was closed");
      const options = { ...OPTIONS, h: makeH(doc) };
      const { nodes, highlight } = await inTurn(async () => {
        const nodes = await renderDocument(parsed, options);
        // The engine registered the comment ranges on the page; they belong to the frame's window, where the nodes
        // will be. Taken out here, in the same turn, so no other render can take them.
        const highlight = CSS.highlights?.get(COMMENTS) ?? null;
        CSS.highlights?.delete(COMMENTS);
        return { nodes, highlight };
      });
      const { removed } = (await skipCleaning()) ? { removed: 0 } : cleanDocumentNodes(nodes);
      // The count the file carries (Word writes it on save), not the rendered boxes: those break only at explicit
      // page breaks and sections, so a long text without them is one box.
      return { ok: true, nodes, highlight, pages: pageCountOf(parsed.extendedPropsPart?.props?.pages), removed };
    } catch (e) {
      return { ok: false, problem: corruptProblem(e instanceof Error ? e.message : String(e)), transient: again };
    }
  }

  async function load() {
    const id = ++generation;
    const again = rendered;
    if (!again) loading = true;
    for (let n = 0; ; n++) {
      const outcome = await attempt(again);
      if (id !== generation) return;
      if (outcome.ok) {
        await show(outcome);
        return;
      }
      if (!outcome.transient || n >= RETRY_AFTER.length) {
        problem = outcome.problem;
        loading = false;
        await tick();
        if (active && id === generation) focusViewer();
        return;
      }
      await sleep(RETRY_AFTER[n]);
      if (id !== generation) return;
    }
  }

  async function show(result: Extract<Outcome, { ok: true }>) {
    if (!(await frameReady) || !fdoc || !fwin || !host) return;
    const overrides = fdoc.createElement("style");
    overrides.textContent = OVERRIDES;
    // One swap: the old rendering stays until the new one is complete.
    host.replaceChildren(...result.nodes, overrides);
    try {
      // The ranges follow their nodes into the frame's document; its own registry paints them.
      if (result.highlight) fwin.CSS.highlights.set(COMMENTS, result.highlight);
      else fwin.CSS.highlights.delete(COMMENTS);
    } catch {
      /* no custom highlights: comments still have their markers */
    }
    problem = null;
    loading = false;
    rendered = true;
    frame.dataset.removed = String(result.removed);
    if (result.pages) workspace.documentPages[tab.id] = result.pages;
    else delete workspace.documentPages[tab.id];
    // The frame may have been hidden (an error was shown): it needs its layout to be measured.
    await tick();
    // Measured when the frame has a layout: now, or (a render that finished while another tab was shown) when the
    // tab is shown again. Until then scale, zoom and place stay as they were.
    needsMeasure = true;
    applyScale();
    restoreScroll();
    if (active) focusViewer();
  }

  /** The pages' width at scale 1. Needs a layout (a hidden frame has none: every width reads 0). */
  function measure() {
    // The place in the document in px at scale 1, so it survives however the scale changes below. (Before the first
    // measurement it is the session's, in px of the scale it was left at: see applyScale.)
    if (measured) savedTop /= scale;
    measured = true;
    host!.style.zoom = "1";
    scale = 1;
    natural = 0;
    for (const page of fdoc!.querySelectorAll<HTMLElement>("section.docx")) natural = Math.max(natural, page.offsetWidth);
    natural += 48;
    needsMeasure = false;
  }

  function restoreScroll() {
    const el = scroller();
    if (el && viewHeight() > 0) el.scrollTop = savedTop;
  }

  function setScale(next: number) {
    if (Math.abs(next - scale) < 0.0005) return;
    // The place in the document stays where it is: the saved position scales with the pages.
    savedTop = (savedTop * next) / scale;
    scale = next;
    host!.style.zoom = String(next);
    frame.dataset.scale = next.toFixed(3);
    // Layout now, so the browser's own clamping of the scroll position happens before the place is put back.
    void scroller()?.scrollHeight;
    restoreScroll();
  }

  /** Fit to width (never enlarging), then Kladde's zoom on top. */
  function applyScale() {
    if (!rendered || viewWidth() === 0) return;
    // A place from the session is in px of the scale it had, which a window of the same width gives again.
    const restored = needsMeasure && !measured ? savedTop : null;
    if (needsMeasure) measure();
    setScale(fitScale(viewWidth(), natural) * userFactor);
    // A vertical scrollbar that the new scale brings or takes away changes the width to fit into, without any
    // resize event: measure again (a step or two settles it).
    for (let i = 0; i < 3; i++) {
      const next = fitScale(viewWidth(), natural) * userFactor;
      if (Math.abs(next - scale) < 0.0005) break;
      setScale(next);
    }
    if (restored !== null) {
      savedTop = restored;
      restoreScroll();
    }
  }

  // A frame that was hidden comes back without its scroll position, and the scroll event of that is not the user's:
  // until the place has been put back, scroll events do not overwrite it.
  let settling = false;
  // One number per activation of the tab: the loop of an earlier one stops when a later one starts (or the tab goes
  // away again), and only the latest clears `settling`. `touched`: the user scrolled in the frame since, which ends
  // the restoring (it would fight the user's own wheel or PageDown).
  let activation = 0;
  let touched = false;

  function onScroll() {
    // A hidden tab has no height and reports 0.
    if (settling || viewHeight() === 0) return;
    savedTop = scroller()?.scrollTop ?? savedTop;
    workspace.setDocumentScroll(tab.id, savedTop);
  }

  function focusViewer() {
    // Not while a dialog of the app is open (a reload finishing behind it must not take its keyboard).
    if (workspace.picker || workspace.dialog || integration.setup || keyCapture.request) return;
    if (problem) {
      problemBox?.focus({ preventScroll: true });
    } else {
      // The frame element takes the page's focus, its window the frame's: keys then scroll the document.
      frame.focus({ preventScroll: true });
      fwin?.focus();
    }
  }

  // First render at once, later ones (file changed on disk, F5) after a short pause: a save arrives as several writes.
  $effect(() => {
    void tab.revision;
    untrack(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), rendered ? RELOAD_DEBOUNCE : 0);
    });
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const factor = zoomFactor(workspace.ui.zoom, settings.fontSize);
    untrack(() => {
      userFactor = factor;
      applyScale();
    });
  });

  // The tab was hidden (no layout, no scroll position): back in view it returns to where it was and takes the focus.
  $effect(() => {
    if (!active) {
      activation++;
      settling = false;
      return;
    }
    untrack(() => {
      const mine = ++activation;
      settling = true;
      touched = false;
      // The frame's layout comes back a frame or two after the tab is shown, and a place set before the content has
      // its height is clamped: put it back until it stays (the scroll events meanwhile are not the user's).
      let frames = 0;
      let steady = 0;
      const settle = () => {
        if (mine !== activation) return;
        if (touched) {
          settling = false;
          return;
        }
        applyScale();
        restoreScroll();
        if (frames === 0) focusViewer();
        const there = viewHeight() > 0 && Math.abs((scroller()?.scrollTop ?? 0) - savedTop) < 1;
        steady = there ? steady + 1 : 0;
        if (++frames < 30 && steady < 3) requestAnimationFrame(settle);
        else settling = false;
      };
      requestAnimationFrame(settle);
    });
  });

  /** The frame's viewport changed (the window, or the frame shown again after it was hidden): fit and place again. */
  function onViewportChange() {
    applyScale();
    restoreScroll();
  }

  /** The app's values of the variables the frame needs, copied into it (they do not inherit into an iframe). */
  function syncTheme() {
    if (!fdoc) return;
    const style = getComputedStyle(document.documentElement);
    for (const name of FRAME_VARIABLES) fdoc.documentElement.style.setProperty(name, style.getPropertyValue(name));
  }

  onMount(() => {
    // Where the document was left (a restored session), before the first rendering needs it.
    savedTop = workspace.documentScroll(tab.id);
    workspace.registerDocument(tab.id, focusViewer);
    const observer = new ResizeObserver(onViewportChange);
    observer.observe(frame);
    // The theme changed (flavor, accent, a live-edited theme.css): the frame follows.
    window.addEventListener("kladde-theme", syncTheme);
    // A frame that does not come up must not leave the tab on "Loading…" for good.
    const wait = window.setTimeout(() => {
      if (fdoc) return;
      markReady(false);
      problem = startProblem;
      loading = false;
    }, FRAME_TIMEOUT);
    return () => {
      clearTimeout(wait);
      observer.disconnect();
      window.removeEventListener("kladde-theme", syncTheme);
    };
  });

  onDestroy(() => {
    generation++;
    activation++;
    markReady(false);
    clearTimeout(timer);
    workspace.registerDocument(tab.id, null);
    // The comment ranges belong to the frame, which goes with the tab; the registries are cleared anyway.
    for (const registry of [fwin?.CSS.highlights, CSS.highlights]) {
      try {
        registry?.delete(COMMENTS);
      } catch {
        /* not available */
      }
    }
    fdoc = fwin = host = null;
  });

  // ------------------------------------------------------------ interaction

  /**
   * Gives an event of the frame to the page as the same event on the frame's element, so the page's own handlers
   * (the window's capture listeners: shortcuts, zoom, mouse buttons) decide as they do everywhere else, and
   * cancels the original when they did.
   */
  function forward(original: Event, copy: Event) {
    if (!frame.dispatchEvent(copy)) original.preventDefault();
  }

  function onFrameKeydown(e: KeyboardEvent) {
    touched = true;
    forward(e, new KeyboardEvent("keydown", keyboardInit(e)));
    // Ctrl+A selects the document, not the whole frame; Ctrl+C is the native copy of the frame's selection.
    if (!e.defaultPrevented && isSelectAll(e)) {
      e.preventDefault();
      const wrapper = fdoc?.querySelector(".docx-wrapper");
      if (wrapper) fwin?.getSelection()?.selectAllChildren(wrapper);
    }
  }

  // Ctrl+wheel is Kladde's zoom, also with the pointer over the document (wheel events do not leave the frame).
  function onFrameWheel(e: WheelEvent) {
    touched = true;
    if (e.ctrlKey) forward(e, new WheelEvent("wheel", wheelInit(e, frame.getBoundingClientRect())));
  }

  // The mouse's back and forward buttons are the tab history (the window handles them, not the frame).
  function onFrameMouseButton(e: MouseEvent) {
    if (e.button === 3 || e.button === 4) forward(e, new MouseEvent(e.type, mouseInit(e, frame.getBoundingClientRect())));
  }

  // The link is found from the target: the frame's elements are of another realm (no `instanceof`).
  function onFrameClick(e: MouseEvent) {
    menu = null;
    const link = (e.target as Element | null)?.closest?.("a");
    if (!link) return;
    // Never navigate, whatever the address or button: the frame must stay what it is.
    e.preventDefault();
    if (e.type !== "click" || e.button !== 0) return;
    void workspace.openHref(link.getAttribute("href") ?? "", {
      baseDir: tab.path ? dirname(tab.path) : null,
      anchor: (id) => fdoc?.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)?.scrollIntoView(),
    });
  }

  // Only an own menu, and only for a selection: WebView2's default menu (reload, print, inspect, …) is not Kladde's.
  // The page's menu handler never sees an event of the frame, and the position is the frame's: translated.
  function onFrameContextMenu(e: MouseEvent) {
    e.preventDefault();
    const text = fwin?.getSelection()?.toString() ?? "";
    const box = frame.getBoundingClientRect();
    menu = text ? { x: box.left + e.clientX, y: box.top + e.clientY, items: [{ label: "Copy", run: () => writeText(text) }] } : null;
  }

  /** The frame's document is ready: the bridges to the page are put on its window and document. */
  function onFrameLoad() {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    const element = doc?.getElementById(FRAME_HOST_ID);
    if (!doc || !win || !element) return;
    // A second load is a new document: the browser throws the frame's document away when the iframe is moved in the
    // page's DOM (a keyed list that reorders), and loads the srcdoc again, empty. What was shown is gone with it.
    const again = fdoc !== null;
    fdoc = doc;
    fwin = win as Window & { CSS: typeof CSS };
    host = element;
    syncTheme();
    win.addEventListener("keydown", onFrameKeydown);
    win.addEventListener("wheel", onFrameWheel, { passive: false });
    win.addEventListener("mousedown", onFrameMouseButton);
    win.addEventListener("mouseup", onFrameMouseButton);
    win.addEventListener("scroll", onScroll, { passive: true });
    // The frame's own viewport is laid out after the frame element: its resize is the reliable signal.
    win.addEventListener("resize", onViewportChange);
    doc.addEventListener("click", onFrameClick);
    doc.addEventListener("auxclick", onFrameClick);
    doc.addEventListener("pointerdown", () => {
      touched = true;
      menu = null;
    });
    doc.addEventListener("contextmenu", onFrameContextMenu);
    markReady(true);
    // Rendered again, like a reload: the old rendering is already gone, and the place and zoom are kept (`measure`
    // takes the scale back to 1 whatever the new document has, and the place with it).
    if (again && !problem) {
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 0);
    }
  }

  async function openExternally() {
    try {
      await api.openInDefaultApp(tab.path!);
    } catch (e) {
      workspace.showNotice("error", `Could not open ${tab.title}: ${e instanceof Error ? e.message : e}`);
    }
  }
</script>

<div class="document-view">
  {#if problem}
    <div class="problem" role="alert" tabindex="-1" bind:this={problemBox}>
      <p class="title">{tab.title} cannot be shown</p>
      <p>{problem.message}</p>
      <div class="buttons">
        <button onclick={openExternally}>Open in default app</button>
        <button onclick={() => workspace.openAsText(tab)}>Open as text</button>
      </div>
    </div>
  {:else if loading}
    <div class="loading">Loading…</div>
  {/if}
  <!-- The sandbox comes first: it has to be there when the frame loads its document. -->
  <iframe
    class="frame"
    class:hidden={!!problem}
    bind:this={frame}
    title={tab.title}
    sandbox={FRAME_SANDBOX}
    srcdoc={frameSrcdoc()}
    onload={onFrameLoad}
  ></iframe>
  {#if menu}
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
  {/if}
</div>

<style>
  .document-view {
    height: 100%;
    position: relative;
    background: var(--bg-alt);
  }
  .frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    /* The desk is there before the frame has painted anything. */
    background: var(--bg-alt);
  }
  .frame.hidden {
    display: none;
  }
  .loading {
    position: absolute;
    inset: 0 0 auto;
    padding: 24px 32px;
    color: var(--fg-dim);
    pointer-events: none;
  }
  .problem {
    padding: 24px 32px;
  }
  .problem {
    color: var(--fg);
    max-width: 640px;
    outline: none;
  }
  .problem .title {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .problem p {
    margin: 0 0 12px;
    user-select: text;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
  .buttons button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 4px 12px;
  }
  .buttons button:hover {
    background: var(--accent);
    color: var(--accent-fg);
  }
</style>
