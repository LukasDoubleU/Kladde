<script lang="ts">
  // Read-only viewer of a document tab (kind "document"): Word documents today, with docx-preview as the engine.
  // Loaded on first use together with its engine (dynamic imports), kept alive while its tab is hidden.
  //
  // The document is untrusted: the engine builds its DOM element by element (no HTML parsing), then
  // `cleanDocumentNodes` removes everything that could fetch another resource, and only then are the nodes
  // attached, into a shadow root so the document's CSS cannot reach Kladde's UI. See docs/architecture.md.
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { api, type DocumentReadError } from "../lib/api";
  import { writeText } from "../lib/clipboard";
  import { cleanDocumentNodes } from "../lib/document-clean";
  import {
    containerOf,
    corruptProblem,
    fitScale,
    problemFor,
    tooLargeProblem,
    zoomFactor,
    type DocumentProblem,
  } from "../lib/documents";
  import { dirname } from "../lib/links";
  import { settings } from "../lib/settings.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";

  let { tab, active }: { tab: Tab; active: boolean } = $props();

  // Changes the user can see are shown as such: insertions underlined, deletions struck through, both colored, and
  // comments as a marker with the text on hover. Hiding them would show a text that is not what the file says
  // (docx-preview's default shows insertions as plain text and drops deletions and comments).
  // Alternative chunks (raw HTML inside the file, shown in an iframe) are never rendered. Images and fonts become
  // data: URLs, which the CSP allows without blob:.
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

  // After the document's own styles (same specificity, later wins): white pages on the themed desk, links that
  // look like links, markers for tracked changes. The CSS variables are the app's and inherit into the shadow root.
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

  let pane: HTMLDivElement;
  let host: HTMLDivElement;
  let problemBox: HTMLDivElement | undefined = $state();
  let root: ShadowRoot | null = null;
  let problem = $state<DocumentProblem | null>(null);
  let loading = $state(true);
  let rendered = false;
  let generation = 0;
  let timer = 0;
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // Layout: the pages' width at scale 1, the scale now, the scroll position in px at that scale.
  let natural = 0;
  let scale = 1;
  let savedTop = 0;
  let userFactor = 1;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  type Outcome =
    | { ok: true; nodes: Node[]; pages: number; removed: number }
    | { ok: false; problem: DocumentProblem; transient: boolean };

  /** One try to read and render. `again`: there is a rendering to keep, so failures that a save in progress causes are expected. */
  async function attempt(again: boolean): Promise<Outcome> {
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
      // Detached nodes: nothing is attached, so nothing is fetched, before the cleaning below has run.
      const nodes = await renderDocument(parsed, OPTIONS);
      const { removed } = cleanDocumentNodes(nodes);
      const pages = nodes.reduce((n, node) => n + (node instanceof Element ? node.querySelectorAll("section.docx").length : 0), 0);
      return { ok: true, nodes, pages, removed };
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
    root ??= host.attachShadow({ mode: "open" });
    const overrides = document.createElement("style");
    overrides.textContent = OVERRIDES;
    // One swap: the old rendering stays until the new one is complete.
    root.replaceChildren(...result.nodes, overrides);
    problem = null;
    loading = false;
    rendered = true;
    host.dataset.removed = String(result.removed);
    workspace.documentPages[tab.id] = result.pages;
    // The pane may have been hidden (an error was shown): it needs its layout to be measured.
    await tick();
    // The pages' width at scale 1: measure unscaled. The place in the document is kept (it is in px of the
    // scale the old pages had, which is the new one too unless the page size changed).
    const top = savedTop;
    host.style.zoom = "1";
    scale = 1;
    natural = 0;
    for (const page of root.querySelectorAll<HTMLElement>("section.docx")) natural = Math.max(natural, page.offsetWidth);
    natural += 48;
    applyScale();
    savedTop = top;
    restoreScroll();
    if (active) focusViewer();
  }

  function restoreScroll() {
    if (pane.clientHeight > 0) pane.scrollTop = savedTop;
  }

  function setScale(next: number) {
    if (Math.abs(next - scale) < 0.0005) return;
    // The place in the document stays where it is: the saved position scales with the pages.
    savedTop = (savedTop * next) / scale;
    scale = next;
    host.style.zoom = String(next);
    host.dataset.scale = next.toFixed(3);
    // Layout now, so the browser's own clamping of the scroll position happens before the place is put back.
    void pane.scrollHeight;
    restoreScroll();
  }

  /** Fit to width (never enlarging), then Kladde's zoom on top. */
  function applyScale() {
    if (!rendered || pane.clientWidth === 0) return;
    setScale(fitScale(pane.clientWidth, natural) * userFactor);
  }

  function onScroll() {
    // A hidden tab has no height and reports 0.
    if (pane.clientHeight === 0) return;
    savedTop = pane.scrollTop;
    workspace.setDocumentScroll(tab.id, savedTop);
  }

  function focusViewer() {
    if (workspace.picker || workspace.dialog) return;
    (problem ? problemBox : pane)?.focus({ preventScroll: true });
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
    if (!active) return;
    untrack(() =>
      requestAnimationFrame(() => {
        applyScale();
        restoreScroll();
        focusViewer();
      }),
    );
  });

  onMount(() => {
    // Where the document was left (a restored session), before the first rendering needs it.
    savedTop = workspace.documentScroll(tab.id);
    workspace.registerDocument(tab.id, focusViewer);
    const observer = new ResizeObserver(() => applyScale());
    observer.observe(pane);
    return () => observer.disconnect();
  });

  onDestroy(() => {
    generation++;
    clearTimeout(timer);
    workspace.registerDocument(tab.id, null);
    // The engine registers the comment ranges globally.
    try {
      CSS.highlights?.delete("docx-comments");
    } catch {
      /* not available */
    }
  });

  // ------------------------------------------------------------ interaction

  function selectionText(): string {
    return window.getSelection()?.toString() ?? "";
  }

  function onKeydown(e: KeyboardEvent) {
    // Ctrl+A selects the document, not the whole page around it.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      const wrapper = root?.querySelector(".docx-wrapper");
      if (wrapper) window.getSelection()?.selectAllChildren(wrapper);
    }
  }

  // The link is found through the composed path: a click inside the shadow root is retargeted to its host.
  function onClick(e: MouseEvent) {
    const link = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
    if (!link) return;
    // Never navigate, whatever the address or button: the page around it must stay.
    e.preventDefault();
    if (e.type !== "click" || e.button !== 0) return;
    void workspace.openHref(link.getAttribute("href") ?? "", {
      baseDir: tab.path ? dirname(tab.path) : null,
      anchor: (id) => root?.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)?.scrollIntoView(),
    });
  }

  // Only an own menu, and only for a selection: WebView2's default menu (reload, print, inspect, …) is not Kladde's.
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const text = selectionText();
    menu = text ? { x: e.clientX, y: e.clientY, items: [{ label: "Copy", run: () => writeText(text) }] } : null;
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
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="pane"
    class:hidden={!!problem}
    bind:this={pane}
    tabindex="0"
    role="document"
    aria-label={tab.title}
    onkeydown={onKeydown}
    onclick={onClick}
    onauxclick={onClick}
    oncontextmenu={onContextMenu}
    onscroll={onScroll}
  >
    <div class="stage"><div class="host" bind:this={host}></div></div>
  </div>
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
  .pane {
    height: 100%;
    overflow: auto;
    outline: none;
    /* The scroll position is kept by hand across zoom changes. */
    overflow-anchor: none;
  }
  .pane.hidden {
    display: none;
  }
  /* As wide as the pages when they are wider than the window (then it scrolls), centered when narrower. */
  .stage {
    display: flex;
    justify-content: center;
    width: max-content;
    min-width: 100%;
  }
  .host {
    width: max-content;
    /* A document can position things (VML shapes, floating objects) fixed or absolute: contained in here, they
       can neither draw over the tabs and bars nor take mouse clicks from them. */
    contain: paint;
    /* What a document without fonts of its own gets, not the UI font. Inherited into the shadow root. */
    font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif;
    font-size: 11pt;
    line-height: normal;
    color: var(--paper-text);
    text-align: left;
    cursor: auto;
    user-select: text;
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
