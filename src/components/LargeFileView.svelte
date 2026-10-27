<script lang="ts">
  // Read-only viewer for files above the large file threshold. Only the visible
  // lines are fetched from the Rust side, so file size barely matters.
  import { api, type LargeLine, type LargeMatch } from "../lib/api";
  import { settings } from "../lib/settings.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";

  let { tab }: { tab: Tab } = $props();
  const id = $derived(tab.largeId!);

  let total = $state(1);
  let done = $state(false);
  let topLine = $state(0);
  let lines: LargeLine[] = $state([]);
  let linesStart = $state(0);
  let height = $state(0);
  let match: LargeMatch | null = $state(null);
  let markedLine: number | null = $state(null);

  let query = $state("");
  let matchCase = $state(false);
  let searching = $state(false);
  let searchMessage = $state("");

  let viewport: HTMLDivElement;
  let searchInput: HTMLInputElement;
  let gotoInput: HTMLInputElement;

  const lineHeight = $derived(Math.round((settings.fontSize + workspace.ui.zoom) * 1.5));
  const visible = $derived(Math.max(1, Math.ceil(height / lineHeight)));
  const maxTop = $derived(Math.max(0, total - visible + 1));
  const gutterChars = $derived(String(total).length + 1);

  // Poll the background indexer until it has counted all lines.
  $effect(() => {
    const fileId = id;
    let cancelled = false;
    const poll = async () => {
      try {
        const info = await api.largeInfo(fileId);
        if (cancelled) return;
        total = Math.max(1, info.lines);
        done = info.done;
        workspace.largeStatus = { lines: info.lines, done: info.done };
        if (!info.done) setTimeout(poll, 150);
      } catch {
        /* closed */
      }
    };
    void poll();
    return () => (cancelled = true);
  });

  // Fetch the visible lines whenever the position or the indexed line count changes.
  let request = 0;
  $effect(() => {
    const start = topLine;
    const count = visible + 1;
    void total;
    const mine = ++request;
    void api.largeLines(id, start, count).then((result) => {
      if (mine !== request) return;
      lines = result;
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
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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

  async function find(forward: boolean) {
    if (!query || searching) return;
    searching = true;
    searchMessage = "Searching…";
    try {
      const from = match ?? { line: topLine, col: 0 };
      let found = await api.largeSearch(id, query, from, forward, !match, matchCase);
      let wrapped = false;
      if (!found) {
        const start = forward ? { line: 0, col: 0 } : { line: total, col: 0 };
        found = await api.largeSearch(id, query, start, forward, true, matchCase);
        wrapped = !!found;
      }
      match = found;
      markedLine = null;
      if (found) {
        reveal(found.line);
        searchMessage = wrapped ? "Wrapped around" : "";
      } else {
        searchMessage = "No results";
      }
    } catch (e) {
      searchMessage = String(e);
    } finally {
      searching = false;
    }
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

  function split(text: string, lineIndex: number): [string, string, string] | null {
    if (!match || match.line !== lineIndex) return null;
    const chars = [...text];
    return [
      chars.slice(0, match.col).join(""),
      chars.slice(match.col, match.col + match.len).join(""),
      chars.slice(match.col + match.len).join(""),
    ];
  }
</script>

<div class="large">
  <div class="toolbar">
    <input
      bind:this={searchInput}
      bind:value={query}
      oninput={() => (match = null)}
      onkeydown={(e) => {
        if (e.key === "Enter") void find(!e.shiftKey);
        else if (e.key === "Escape") viewport.focus();
        else return;
        e.preventDefault();
      }}
      placeholder="Find (Enter / Shift+Enter)"
      spellcheck="false"
    />
    <label title="Match case"><input type="checkbox" bind:checked={matchCase} onchange={() => (match = null)} /> Aa</label>
    <button title="Previous (Shift+F3)" onclick={() => find(false)}>↑</button>
    <button title="Next (F3)" onclick={() => find(true)}>↓</button>
    <span class="message">{searchMessage}</span>
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
          {@const parts = split(line.text, index)}
          <div class="line" class:marked={index === markedLine}>
            <span class="number">{index + 1}</span>
            <span class="text"
              >{#if parts}{parts[0]}<mark>{parts[1]}</mark>{parts[2]}{:else}{line.text}{/if}{#if line.truncated}<span
                  class="truncated"
                  title="Line shortened for display">…</span
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
  .toolbar label {
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--fg-dim);
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
