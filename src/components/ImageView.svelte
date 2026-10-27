<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import type { Tab } from "../lib/workspace.svelte";

  let { tab, onsize }: { tab: Tab; onsize: (size: { w: number; h: number } | null) => void } = $props();

  let actualSize = $state(false);
  // The modification time busts the cache when the image changes on disk.
  const src = $derived(`${convertFileSrc(tab.path!)}?v=${tab.mtime}`);
</script>

<div class="image-view" class:actual={actualSize}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <img
    {src}
    alt={tab.title}
    title={actualSize ? "Click to fit to window" : "Click for actual size"}
    onclick={() => (actualSize = !actualSize)}
    onload={(e) => {
      const img = e.currentTarget as HTMLImageElement;
      onsize({ w: img.naturalWidth, h: img.naturalHeight });
    }}
    onerror={() => onsize(null)}
  />
</div>

<style>
  .image-view {
    height: 100%;
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 16px;
    background-color: var(--bg-alt);
    background-image:
      linear-gradient(45deg, var(--bg-hover) 25%, transparent 25%),
      linear-gradient(-45deg, var(--bg-hover) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, var(--bg-hover) 75%),
      linear-gradient(-45deg, transparent 75%, var(--bg-hover) 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  }
  img {
    max-width: 100%;
    max-height: 100%;
    cursor: zoom-in;
    image-rendering: auto;
  }
  .actual {
    place-items: start;
  }
  .actual img {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
</style>
