<script lang="ts">
  import { capturePointer } from "../lib/pointer";
  import { writeText } from "../lib/clipboard";
  import { workspace, type Tab } from "../lib/workspace.svelte";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";

  let strip: HTMLDivElement;
  let menu: { x: number; y: number; items: MenuItem[] } | null = $state(null);

  // Reordering by dragging. Tauri's file drop handling disables HTML5 drag and drop.
  let drag: { id: string; startX: number; moved: boolean } | null = null;

  function onPointerDown(e: PointerEvent, tab: Tab) {
    if (e.button === 1) {
      e.preventDefault();
      void workspace.close(tab.id);
      return;
    }
    if (e.button !== 0) return;
    workspace.activate(tab.id);
    drag = { id: tab.id, startX: e.clientX, moved: false };
    capturePointer(e);
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < 6) return;
    drag.moved = true;
    const elements = [...strip.querySelectorAll<HTMLElement>("[data-tab]")];
    const from = workspace.tabs.findIndex((t) => t.id === drag!.id);
    const to = elements.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right;
    });
    if (to >= 0 && to !== from) workspace.moveTab(from, to);
  }

  function onPointerUp() {
    drag = null;
  }

  function onWheel(e: WheelEvent) {
    if (e.deltaY && !e.deltaX) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }

  function openMenu(e: MouseEvent, tab: Tab) {
    e.preventDefault();
    const index = workspace.tabs.indexOf(tab);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Close", run: () => workspace.close(tab.id) },
        { label: "Close others", run: () => workspace.closeOthers(tab.id), disabled: workspace.tabs.length < 2 },
        {
          label: "Close tabs to the right",
          run: () => workspace.closeToTheRight(tab.id),
          disabled: index === workspace.tabs.length - 1,
        },
        { separator: true },
        { label: "Copy full path", run: () => writeText(tab.path!), disabled: !tab.path },
        { label: "Copy file name", run: () => writeText(tab.title) },
        { label: "Reveal in Explorer", run: () => revealItemInDir(tab.path!), disabled: !tab.path },
        { separator: true },
        { label: "Reload from disk", run: () => workspace.reload(tab), disabled: !tab.path },
      ],
    };
  }

  $effect(() => {
    // Keep the active tab visible.
    const id = workspace.activeId;
    queueMicrotask(() => strip?.querySelector(`[data-tab="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });
</script>

<div class="tabbar">
  <div
    class="strip"
    bind:this={strip}
    onwheel={onWheel}
    ondblclick={(e) => e.target === strip && workspace.newUntitled()}
    role="tablist"
    tabindex="-1"
  >
    {#each workspace.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === workspace.activeId}
        class:dirty={tab.dirty}
        data-tab={tab.id}
        title={tab.path ?? tab.title}
        role="tab"
        tabindex="-1"
        aria-selected={tab.id === workspace.activeId}
        onpointerdown={(e) => onPointerDown(e, tab)}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        oncontextmenu={(e) => openMenu(e, tab)}
      >
        {#if tab.kind === "large"}<span class="badge" title="Large file: read-only viewer">L</span>{/if}
        {#if tab.external}<span class="badge warn" title="Changed on disk">!</span>{/if}
        <span class="title">{tab.title}</span>
        <button
          class="close"
          title="Close"
          tabindex="-1"
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => workspace.close(tab.id)}
        >
          <span class="dot"></span>
          <span class="x">×</span>
        </button>
      </div>
    {/each}
  </div>
  <button class="new" title="New tab (Ctrl+N)" onclick={() => workspace.newUntitled()}>+</button>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
  .tabbar {
    display: flex;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    height: 34px;
    flex: none;
    user-select: none;
  }
  .strip {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    flex: 1;
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 12px;
    max-width: 220px;
    min-width: 80px;
    border-right: 1px solid var(--border);
    color: var(--fg-dim);
    cursor: default;
    flex: none;
    position: relative;
  }
  .tab:hover {
    background: var(--bg-hover);
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg);
  }
  .tab.active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: var(--accent);
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    border: 1px solid var(--fg-dim);
    border-radius: 3px;
    padding: 0 3px;
    line-height: 14px;
  }
  .badge.warn {
    color: var(--dirty);
    border-color: var(--dirty);
  }
  .close {
    width: 20px;
    height: 20px;
    border: none;
    background: none;
    border-radius: 4px;
    padding: 0;
    display: grid;
    place-items: center;
    flex: none;
    color: var(--fg-dim);
  }
  .close:hover {
    background: var(--border);
    color: var(--fg);
  }
  .close .x {
    visibility: hidden;
    font-size: 16px;
    line-height: 1;
  }
  .tab:hover .close .x,
  .tab.active .close .x {
    visibility: visible;
  }
  .close .dot {
    display: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--dirty);
  }
  /* Unsaved tabs show a dot that turns into × on hover. */
  .tab.dirty .close .dot {
    display: block;
    grid-area: 1 / 1;
  }
  .tab.dirty .close .x {
    grid-area: 1 / 1;
    visibility: hidden;
  }
  .tab.dirty .close:hover .dot {
    display: none;
  }
  .tab.dirty .close:hover .x {
    visibility: visible;
  }
  .new {
    width: 34px;
    border: none;
    background: none;
    font-size: 18px;
    color: var(--fg-dim);
    flex: none;
  }
  .new:hover {
    color: var(--fg);
    background: var(--bg-hover);
  }
</style>
