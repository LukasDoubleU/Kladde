<script lang="ts">
  // Shown in place of the large file view for a large tab that was restored without its file (renamed, a drive
  // that is not connected yet, a save that was killed): only its unsaved edits are left, in the journal. They
  // are applied when the file is there again (workspace.retryMissing, also on window focus).
  import { workspace, type Tab } from "../lib/workspace.svelte";

  let { tab }: { tab: Tab } = $props();
</script>

<div class="missing" role="status">
  <p class="title">This file is missing.</p>
  <p class="path">{tab.path}</p>
  <p class="dim">
    Your unsaved changes are kept. They come back when the file is there again, for example after it is renamed back
    or its drive is connected.
  </p>
  <div class="buttons">
    <button class="retry" onclick={() => workspace.retryMissing(tab)}>Try again</button>
    <button class="discard" onclick={() => workspace.close(tab.id)}>Discard edits</button>
  </div>
</div>

<style>
  .missing {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    text-align: center;
    background: var(--bg-alt);
    user-select: text;
  }
  p {
    margin: 0;
    max-width: 560px;
  }
  .title {
    font-size: 16px;
  }
  .path {
    font-family: var(--editor-font);
    color: var(--fg-dim);
    overflow-wrap: anywhere;
  }
  .dim {
    color: var(--fg-dim);
  }
  .buttons {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 2px 10px;
  }
  button:hover {
    border-color: var(--accent);
  }
</style>
