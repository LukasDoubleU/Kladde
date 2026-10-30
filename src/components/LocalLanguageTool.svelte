<script lang="ts">
  import { untrack } from "svelte";
  import { localLanguageTool as lt } from "../lib/languagetool-local.svelte";
  import { settings } from "../lib/settings.svelte";
  import { workspace } from "../lib/workspace.svelte";

  let { active }: { active: boolean } = $props();

  // What is installed is read again whenever the page is shown: the server may have started or stopped meanwhile.
  $effect(() => {
    if (active) untrack(() => void lt.refresh());
  });

  const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

  const status = $derived.by(() => {
    if (lt.label) return lt.label;
    const info = lt.info;
    if (!info?.installed) return "Not installed.";
    const run = lt.server === "running" ? "Running." : lt.server === "starting" ? "Starting…" : "Not running; it starts with the first check.";
    return `Installed: LanguageTool ${info.version} with Java ${info.javaVersion}, ${mb(info.size)} on disk. ${run}`;
  });
</script>

<div class="local" data-local-languagetool>
  <div class="text">
    <div class="title">Local LanguageTool</div>
    <p class="status" role="status">{status}</p>
    <p class="description">
      Kladde downloads LanguageTool and a Java runtime once (about 300 MB), starts them on your machine when
      grammar checking needs them and stops them when it is turned off or idle. Nothing leaves your machine
      after the download.
      {#if settings.languageToolServer.trim()}
        It is not used while a server is set below.
      {/if}
    </p>
  </div>
  <div class="control">
    {#if lt.busy}
      <button disabled={lt.cancelling} onclick={() => lt.cancel()}>Cancel</button>
    {:else if lt.installed}
      <button onclick={() => workspace.removeLocalLanguageTool()}>Remove</button>
    {:else}
      <button onclick={() => workspace.downloadLocalLanguageTool()}>Download</button>
    {/if}
  </div>
</div>

<style>
  .local {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 0 12px 13px;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .text {
    min-width: 0;
    flex: 1;
  }
  .title {
    font-size: 13.5px;
    font-weight: 600;
  }
  .status {
    margin: 3px 0 0;
  }
  .description {
    margin: 3px 0 4px;
    color: var(--fg-dim);
    line-height: 1.4;
  }
  .control {
    flex: none;
    padding-top: 1px;
  }
  button {
    border: 1px solid var(--border);
    background: var(--bg-alt);
    border-radius: 4px;
    padding: 4px 12px;
  }
  button:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  button:disabled {
    opacity: 0.5;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
