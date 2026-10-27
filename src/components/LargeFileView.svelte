<script lang="ts">
  // Read-only viewer for files above the large file threshold. Only the visible
  // lines are fetched from the Rust side, so file size barely matters.
  import type { Language } from "@codemirror/language";
  import { untrack } from "svelte";
  import { api, type LargeLine, type LargeMatch } from "../lib/api";
  import { detectLanguage } from "../lib/languages";
  import { highlightLines, markSpans, unitOffset, type Span } from "../lib/linehighlight";
  import { capturePointer } from "../lib/pointer";
  import { settings } from "../lib/settings.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";

  let { tab }: { tab: Tab } = $props();
  const id = $derived(tab.largeId!);

  type ViewLine = LargeLine & { spans: Span[] };

  let total = $state(1);
  let done = $state(false);
  let topLine = $state(0);
  let lines: ViewLine[] = $state([]);
  let linesStart = $state(0);
  let height = $state(0);
  let match: LargeMatch | null = $state(null);
  let markedLine: number | null = $state(null);

  let query = $state("");
  let matchCase = $state(false);
  let useRegex = $state(false);
  let searching = $state(false);
  let searchMessage = $state("");

  let viewport: HTMLDivElement;
  let searchInput: HTMLInputElement;
  let gotoInput: HTMLInputElement;

  const lineHeight = $derived(Math.round((settings.fontSize + workspace.ui.zoom) * 1.5));
  const visible = $derived(Math.max(1, Math.ceil(height / lineHeight)));
  const maxTop = $derived(Math.max(0, total - visible + 1));
  const gutterChars = $derived(String(total).length + 1);

  // The file grew (the periodic check updates the tab's size): keep showing the end if it was shown.
  let lastSize = untrack(() => tab.size);
  let followEnd = false;
  $effect(() => {
    const size = tab.size;
    untrack(() => {
      if (size > lastSize) followEnd = topLine >= maxTop;
      lastSize = size;
    });
  });

  // Poll the background indexer until it has counted all lines; again after the file grew.
  $effect(() => {
    const fileId = id;
    void tab.size;
    let cancelled = false;
    const poll = async () => {
      try {
        const info = await api.largeInfo(fileId);
        if (cancelled) return;
        total = Math.max(1, info.lines);
        done = info.done;
        workspace.largeStatus = { lines: info.lines, done: info.done };
        if (followEnd) scrollTo(maxTop);
        if (info.done) followEnd = false;
        else setTimeout(poll, 150);
      } catch {
        /* closed */
      }
    };
    void poll();
    return () => (cancelled = true);
  });

  // A reopened file (truncated or rotated) may be shorter than the position.
  $effect(() => {
    if (topLine > maxTop) topLine = maxTop;
  });
  $effect(() => {
    void id;
    match = null;
    markedLine = null;
  });

  // Highlighting by the file's language, as far as it works line by line (e.g. log files).
  let parser = $state.raw<Language["parser"] | null>(null);
  $effect(() => {
    const desc = tab.path ? detectLanguage(tab.path, "") : null;
    parser = null;
    // Markdown depends on blocks that start above the window.
    if (!desc || desc.name === "Markdown") return;
    let stale = false;
    desc
      .load()
      .then((support) => {
        if (!stale) parser = support.language.parser;
      })
      .catch(() => {});
    return () => (stale = true);
  });

  function withSpans(result: LargeLine[], language: Language["parser"] | null): ViewLine[] {
    let spans: Span[][] | null = null;
    if (language) {
      try {
        spans = highlightLines(
          language,
          result.map((l) => l.text),
        );
      } catch {
        /* show plain text */
      }
    }
    return result.map((l, i) => ({ ...l, spans: spans?.[i] ?? [{ text: l.text, cls: "" }] }));
  }

  // Fetch the visible lines whenever the position, the indexed line count or the file changes.
  let request = 0;
  $effect(() => {
    const start = topLine;
    const count = visible + 1;
    void total;
    void tab.size;
    const language = parser;
    const mine = ++request;
    void api.largeLines(id, start, count).then((result) => {
      if (mine !== request) return;
      lines = withSpans(result, language);
      linesStart = start;
    });
  });

  function scrollTo(line: number) {
    topLine = Math.max(0, Math.min(Math.round(line), maxTop));
  }

  /** Scrolls so that `line` is visible, about a third down from the top. */
  function reveal(line: number) {
    if (line < topLine || line >= topLine + visible - 1) scrollTo(line - Math.floor(visible / 3));
  }

  let wheelRest = 0;
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * lineHeight : e.deltaMode === 2 ? e.deltaY * height : e.deltaY;
    wheelRest += px / lineHeight;
    const step = Math.trunc(wheelRest);
    wheelRest -= step;
    if (step) scrollTo(topLine + step);
  }

  function onKeydown(e: KeyboardEvent) {
    const page = Math.max(1, visible - 1);
    if (e.key === "ArrowDown") scrollTo(topLine + 1);
    else if (e.key === "ArrowUp") scrollTo(topLine - 1);
    else if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) scrollTo(topLine + page);
    else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) scrollTo(topLine - page);
    else if (e.key === "Home" && e.ctrlKey) scrollTo(0);
    else if (e.key === "End" && e.ctrlKey) scrollTo(maxTop);
    else if (e.key === "Escape" && searching) cancelSearch();
    else if (e.key === "f" && e.ctrlKey) focusSearch();
    else if (e.key === "F3") void find(!e.shiftKey);
    else return;
    e.preventDefault();
  }

  // Scrollbar: drawn by hand, because a native one cannot address millions of lines.
  let track: HTMLDivElement;
  const thumbHeight = $derived(Math.max(28, height * Math.min(1, visible / total)));
  const thumbTop = $derived(maxTop ? ((height - thumbHeight) * topLine) / maxTop : 0);
  let thumbDrag: { offset: number } | null = null;

  function onThumbDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    thumbDrag = { offset: e.clientY - track.getBoundingClientRect().top - thumbTop };
    capturePointer(e);
  }

  function onThumbMove(e: PointerEvent) {
    if (!thumbDrag) return;
    const y = e.clientY - track.getBoundingClientRect().top - thumbDrag.offset;
    scrollTo((y / Math.max(1, height - thumbHeight)) * maxTop);
  }

  function onTrackDown(e: PointerEvent) {
    const y = e.clientY - track.getBoundingClientRect().top;
    scrollTo(topLine + (y < thumbTop ? -1 : 1) * Math.max(1, visible - 1));
  }

  // Searches run in Rust; a newer search or a cancel stops the one before (it then reports `cancelled`).
  let searchToken = 0;
  async function find(forward: boolean) {
    if (!query) return;
    const mine = ++searchToken;
    searching = true;
    searchMessage = "Searching…";
    try {
      const from = match ?? { line: topLine, col: 0 };
      let result = await api.largeSearch(id, query, from, forward, !match, matchCase, useRegex);
      if (mine !== searchToken || result.cancelled) return;
      let wrapped = false;
      if (!result.found) {
        const start = forward ? { line: 0, col: 0 } : { line: Number.MAX_SAFE_INTEGER, col: 0 };
        result = await api.largeSearch(id, query, start, forward, true, matchCase, useRegex);
        if (mine !== searchToken || result.cancelled) return;
        wrapped = !!result.found;
      }
      match = result.found;
      markedLine = null;
      if (result.found) {
        reveal(result.found.line);
        searchMessage = wrapped ? "Wrapped around" : "";
      } else {
        searchMessage = "No results";
      }
    } catch (e) {
      if (mine === searchToken) searchMessage = String(e);
    } finally {
      if (mine === searchToken) searching = false;
    }
  }

  function cancelSearch() {
    searchToken++;
    searching = false;
    searchMessage = "Search cancelled";
    void api.largeSearchCancel(id);
  }

  function searchOptionChanged() {
    match = null;
    searchMessage = "";
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  function gotoLine(line: number) {
    const target = Math.max(0, Math.min(line - 1, total - 1));
    markedLine = target;
    match = null;
    reveal(target);
    viewport.focus();
  }

  $effect(() => {
    workspace.largeApi = { gotoLine, focusSearch };
    return () => (workspace.largeApi = null);
  });

  /** The spans of a line, with the search match marked. */
  function lineSpans(line: ViewLine, lineIndex: number): Span[] {
    if (!match || match.line !== lineIndex) return line.spans;
    const from = unitOffset(line.text, match.col);
    return markSpans(line.spans, from, from + unitOffset(line.text.slice(from), match.len));
  }
</script>

<div class="large">
  <div class="toolbar">
    <input
      bind:this={searchInput}
      bind:value={query}
      oninput={() => (match = null)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === "F3") void find(!e.shiftKey);
        else if (e.key === "Escape") {
          if (searching) cancelSearch();
          else viewport.focus();
        } else return;
        e.preventDefault();
      }}
      placeholder="Find (Enter / Shift+Enter)"
      spellcheck="false"
    />
    <button
      class="toggle"
      class:on={matchCase}
      aria-pressed={matchCase}
      title="Match case"
      onclick={() => {
        matchCase = !matchCase;
        searchOptionChanged();
      }}>Aa</button
    >
    <button
      class="toggle"
      class:on={useRegex}
      aria-pressed={useRegex}
      title="Regular expression"
      onclick={() => {
        useRegex = !useRegex;
        searchOptionChanged();
      }}>.*</button
    >
    <button title="Previous (Shift+F3)" onclick={() => find(false)}>↑</button>
    <button title="Next (F3)" onclick={() => find(true)}>↓</button>
    <span class="message">{searchMessage}</span>
    {#if searching}<button class="wide" title="Cancel the search (Esc)" onclick={cancelSearch}>Cancel</button>{/if}
    <span class="spacer"></span>
    <input
      class="goto"
      bind:this={gotoInput}
      placeholder="Go to line"
      inputmode="numeric"
      onkeydown={(e) => {
        if (e.key !== "Enter") return;
        const n = parseInt(gotoInput.value, 10);
        if (Number.isFinite(n)) gotoLine(n);
        gotoInput.value = "";
      }}
    />
    {#if !done}<span class="message">Indexing… {total.toLocaleString()} lines</span>{/if}
    <button
      class="wide"
      title={tab.size > workspace.largeEditLimit
        ? "Too large for the editor"
        : "Load the whole file into the editor (needs a lot of memory)"}
      disabled={tab.size > workspace.largeEditLimit}
      onclick={() => workspace.openLargeInEditor(tab)}>Open in editor…</button
    >
  </div>

  <div class="body">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="viewport"
      bind:this={viewport}
      bind:clientHeight={height}
      onwheel={onWheel}
      onkeydown={onKeydown}
      tabindex="0"
      role="document"
      style:--line-height="{lineHeight}px"
      style:--gutter="{gutterChars}ch"
    >
      <div class="lines">
        {#each lines as line, i (linesStart + i)}
          {@const index = linesStart + i}
          {@const spans = lineSpans(line, index)}
          <div class="line" class:marked={index === markedLine}>
            <span class="number">{index + 1}</span>
            <span class="text"
              >{#each spans as s}{#if s.mark}<mark class={s.cls}>{s.text}</mark>{:else if s.cls}<span class={s.cls}
                    >{s.text}</span
                  >{:else}{s.text}{/if}{/each}{#if line.truncated}<span class="truncated" title="Line shortened for display"
                  >…</span
                >{/if}</span
            >
          </div>
        {/each}
      </div>
    </div>
    <div class="track" bind:this={track} onpointerdown={onTrackDown} role="presentation">
      <div
        class="thumb"
        style:height="{thumbHeight}px"
        style:top="{thumbTop}px"
        onpointerdown={onThumbDown}
        onpointermove={onThumbMove}
        onpointerup={() => (thumbDrag = null)}
        role="presentation"
      ></div>
    </div>
  </div>
</div>

<style>
  .large {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
    flex: none;
  }
  .toolbar input:not([type="checkbox"]) {
    font: inherit;
    padding: 3px 6px;
    width: 260px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    outline: none;
  }
  .toolbar input:focus {
    border-color: var(--accent);
  }
  .toolbar input.goto {
    width: 110px;
  }
  .toolbar button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 3px;
    width: 26px;
    height: 24px;
  }
  .toolbar button.wide {
    width: auto;
    padding: 0 8px;
  }
  .toolbar button.toggle {
    color: var(--fg-dim);
  }
  .toolbar button.toggle.on {
    color: var(--fg);
    border-color: var(--accent);
    background: var(--active-line);
  }
  .toolbar button:disabled {
    opacity: 0.5;
  }
  .message {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .viewport {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    outline: none;
    font-family: var(--editor-font);
    font-size: var(--editor-font-size);
    font-variant-ligatures: var(--editor-ligatures);
    line-height: var(--line-height);
  }
  .lines {
    min-width: max-content;
  }
  .line {
    display: flex;
    height: var(--line-height);
    white-space: pre;
  }
  .line.marked {
    background: var(--active-line);
  }
  .number {
    flex: none;
    width: var(--gutter);
    padding-right: 1ch;
    box-sizing: content-box;
    text-align: right;
    color: var(--fg-dim);
    border-right: 1px solid var(--border);
    margin-right: 6px;
    user-select: none;
    position: sticky;
    left: 0;
    background: var(--bg);
  }
  .marked .number {
    background: var(--active-line);
    color: var(--fg);
  }
  mark {
    background: var(--search-match-selected);
    color: inherit;
    outline: 1px solid var(--search-match-border);
  }
  .truncated {
    color: var(--fg-dim);
    padding: 0 4px;
  }
  .track {
    width: 14px;
    flex: none;
    position: relative;
    background: var(--bg);
    border-left: 1px solid var(--border);
  }
  .thumb {
    position: absolute;
    left: 3px;
    right: 3px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--fg-dim) 45%, transparent);
  }
  .thumb:hover {
    background: var(--fg-dim);
  }
</style>
