<script lang="ts">
  import { updates } from "../lib/updates.svelte";
</script>

{#if updates.available}
  {@const info = updates.available}
  <div class="update" role="region" aria-label="Update">
    {#if updates.installing}
      <span>{updates.installing} Kladde restarts when it is done.</span>
    {:else}
      <span>Kladde {info.version} is available.</span>
      <button onclick={() => updates.install()}>{info.portable ? "Download" : "Update now"}</button>
      <button onclick={() => updates.openReleaseNotes()}>Release notes</button>
      <button onclick={() => updates.later()}>Later</button>
    {/if}
  </div>
{/if}

<style>
  .update {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--banner);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .update button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 2px 10px;
  }
</style>
