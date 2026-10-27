<script lang="ts" module>
  export type MenuItem =
    | { label: string; run: () => unknown; disabled?: boolean; separator?: never }
    | { separator: true; label?: never; run?: never; disabled?: never };
</script>

<script lang="ts">
  let { x, y, items, onclose }: { x: number; y: number; items: MenuItem[]; onclose: () => void } = $props();

  let menu: HTMLDivElement;
  let left = $state(0);
  let top = $state(0);

  $effect(() => {
    // Keep the menu inside the window.
    const r = menu.getBoundingClientRect();
    left = Math.min(x, window.innerWidth - r.width - 4);
    top = Math.min(y, window.innerHeight - r.height - 4);
  });

  function run(item: MenuItem) {
    onclose();
    if (!item.separator) void item.run();
  }
</script>

<svelte:window
  onpointerdown={(e) => !menu.contains(e.target as Node) && onclose()}
  onkeydown={(e) => e.key === "Escape" && onclose()}
  onblur={onclose}
/>

<div class="menu" bind:this={menu} style:left="{left}px" style:top="{top}px" role="menu">
  {#each items as item, i (i)}
    {#if item.separator}
      <div class="sep"></div>
    {:else}
      <button role="menuitem" disabled={item.disabled} onclick={() => run(item)}>{item.label}</button>
    {/if}
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 190px;
    padding: 4px;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.25);
    display: flex;
    flex-direction: column;
  }
  button {
    text-align: left;
    border: none;
    background: none;
    padding: 5px 10px;
    border-radius: 4px;
  }
  button:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-fg);
  }
  button:disabled {
    color: var(--fg-dim);
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 4px 2px;
  }
</style>
