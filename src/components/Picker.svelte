<script lang="ts">
  import { workspace, type PickItem } from "../lib/workspace.svelte";

  const request = $derived(workspace.picker!);
  let query = $state("");
  let selected = $state(0);
  let list: HTMLDivElement | undefined = $state();

  /** Substring matches first, then fuzzy (in-order characters) matches. */
  function score(label: string, q: string): number {
    const l = label.toLowerCase();
    if (!q) return 1;
    const at = l.indexOf(q);
    if (at === 0) return 3;
    if (at > 0) return 2;
    let i = 0;
    for (const ch of l) if (ch === q[i]) i++;
    return i === q.length ? 1 : 0;
  }

  const filtered: PickItem[] = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return request.items
      .map((item) => ({ item, s: score(item.label, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item);
  });

  $effect(() => {
    void filtered;
    selected = 0;
  });

  $effect(() => {
    list?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function accept(item?: PickItem) {
    const chosen = item ?? filtered[selected];
    if (chosen) request.resolve(chosen);
    else if (request.freeText && query.trim()) request.resolve(query.trim());
    else request.resolve(null);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") selected = Math.min(selected + 1, filtered.length - 1);
    else if (e.key === "ArrowUp") selected = Math.max(selected - 1, 0);
    else if (e.key === "PageDown") selected = Math.min(selected + 10, filtered.length - 1);
    else if (e.key === "PageUp") selected = Math.max(selected - 10, 0);
    else if (e.key === "Enter") accept();
    else if (e.key === "Escape") request.resolve(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function autofocus(node: HTMLInputElement) {
    node.focus();
  }
</script>

<div class="backdrop" role="presentation" onpointerdown={() => request.resolve(null)}></div>
<div class="picker" role="dialog">
  <input
    use:autofocus
    bind:value={query}
    onkeydown={onKeydown}
    placeholder={request.placeholder}
    spellcheck="false"
    autocomplete="off"
  />
  {#if filtered.length}
    <div class="list" bind:this={list} role="listbox">
      {#each filtered as item, i (item.id)}
        <button
          class:selected={i === selected}
          data-index={i}
          role="option"
          aria-selected={i === selected}
          tabindex="-1"
          onpointermove={() => (selected = i)}
          onclick={() => accept(item)}
        >
          <span>{item.label}</span>
          {#if item.detail}<span class="detail">{item.detail}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
  }
  .picker {
    position: fixed;
    z-index: 51;
    top: 40px;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 40px));
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.3);
    padding: 6px;
  }
  input {
    width: 100%;
    font: inherit;
    font-size: 14px;
    padding: 6px 8px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 4px;
    outline: none;
  }
  .list {
    max-height: min(420px, 60vh);
    overflow-y: auto;
    margin-top: 6px;
  }
  button {
    display: flex;
    width: 100%;
    gap: 12px;
    justify-content: space-between;
    border: none;
    background: none;
    padding: 5px 8px;
    border-radius: 4px;
    text-align: left;
  }
  button.selected {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .detail {
    color: var(--fg-dim);
    font-size: 12px;
  }
  button.selected .detail {
    color: inherit;
    opacity: 0.85;
  }
</style>
