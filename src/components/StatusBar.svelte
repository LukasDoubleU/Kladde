<script lang="ts">
  import { runAction, shortcutLabel } from "../lib/actions";
  import { keyHint } from "../lib/keyhint.svelte";
  import { workspace } from "../lib/workspace.svelte";

  let { imageSize }: { imageSize: { w: number; h: number } | null } = $props();

  const tab = $derived(workspace.active);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
  }

  function encodingLabel(encoding: string, bom: boolean) {
    if (encoding === "UTF-8") return bom ? "UTF-8 BOM" : "UTF-8";
    if (encoding === "windows-1252") return "ANSI (1252)";
    return encoding;
  }
</script>

<footer>
  {#if tab?.kind === "text"}
    <span>Ln {workspace.cursor.line}, Col {workspace.cursor.col}</span>
    {#if workspace.cursor.selected > 0}
      <span>
        {workspace.cursor.selected} selected{workspace.cursor.selections > 1 ? ` in ${workspace.cursor.selections}` : ""}
      </span>
    {/if}
    <span class="dim">{workspace.cursor.lines.toLocaleString()} lines</span>
    {#if tab.binary}<span class="warn" title="The file contains NUL bytes">binary</span>{/if}
  {:else if tab?.kind === "large"}
    <span>Ln {workspace.cursor.line.toLocaleString()}, Col {workspace.cursor.col}</span>
    <span>
      {workspace.largeStatus.lines.toLocaleString()} lines{workspace.largeStatus.done ? "" : " (indexing…)"}
    </span>
    <span class="dim">{formatSize(workspace.largeStatus.size || tab.size)}</span>
    <span class="dim" title="Edited in place: only the changes are kept in memory">
      {tab.journal === "restoring" ? "Restoring unsaved changes…" : workspace.largeStatus.done ? "Large file" : "Large file: editable once indexed"}
    </span>
  {:else if tab?.kind === "compare"}
    {@const changes = workspace.compareChanges[tab.id]}
    {#if changes !== undefined}
      <span>{changes === 0 ? "No differences" : `${changes} ${changes === 1 ? "change" : "changes"}`}</span>
    {/if}
    <span class="dim">{shortcutLabel("compare.next")} / {shortcutLabel("compare.previous")}: next / previous change</span>
  {:else if tab?.kind === "image"}
    {#if imageSize}<span>{imageSize.w} × {imageSize.h}</span>{/if}
    <span class="dim">{formatSize(tab.size)}</span>
  {/if}

  {#if keyHint.text}<span class="chord" role="status">{keyHint.text}</span>{/if}

  <span class="spacer"></span>

  {#if workspace.ui.zoom !== 0}
    <button title="Reset zoom (Ctrl+0)" onclick={() => workspace.zoom(null)}>
      {workspace.ui.zoom > 0 ? "+" : ""}{workspace.ui.zoom} pt
    </button>
  {/if}
  {#if tab?.kind === "text"}
    {#if workspace.grammar.state !== "off"}
      {@const g = workspace.grammar}
      <button
        class:warn={g.state === "error" || g.state === "limited"}
        title={g.message || "Grammar checking with LanguageTool: click to set the language"}
        onclick={() => runAction("view.setGrammarLanguage")}
      >
        {g.state === "checking"
          ? "Grammar: checking…"
          : g.state === "error"
            ? "Grammar: unavailable"
            : g.state === "limited"
              ? "Grammar: waiting"
              : g.count === 0
                ? "Grammar: no issues"
                : `Grammar: ${g.count} ${g.count === 1 ? "issue" : "issues"}`}
      </button>
    {/if}
    {#if workspace.previewAvailable(tab)}
      <button title="Toggle preview (Ctrl+Shift+V)" onclick={() => workspace.togglePreview()}>
        Preview: {tab.preview === "off" ? "off" : tab.preview === "split" ? "side by side" : "only"}
      </button>
    {/if}
    <button title="Toggle word wrap (Alt+Z)" onclick={() => workspace.toggleWrap()}>
      {workspace.ui.wordWrap ? "Wrap" : "No wrap"}
    </button>
    <button title="Select language" onclick={() => runAction("language.select")}>{tab.language ?? "Plain Text"}</button>
    <button title="Line endings" onclick={() => runAction("eol.select")}>{tab.eol}</button>
    <button title="Encoding" onclick={() => runAction("encoding.select")}>{encodingLabel(tab.encoding, tab.bom)}</button>
  {:else if tab?.kind === "large"}
    <span title="New lines get the line ending the file uses most">{tab.eol}</span>
    <span>{encodingLabel(tab.encoding, tab.bom)}</span>
  {/if}
</footer>

<style>
  footer {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 24px;
    padding: 0 6px;
    flex: none;
    background: var(--bg-alt);
    border-top: 1px solid var(--border);
    color: var(--fg);
    font-size: 12px;
    white-space: nowrap;
    user-select: none;
  }
  span,
  button {
    padding: 0 8px;
    line-height: 22px;
  }
  button {
    border: none;
    background: none;
    border-radius: 3px;
    font-size: 12px;
  }
  button:hover {
    background: var(--bg-hover);
  }
  .dim {
    color: var(--fg-dim);
  }
  .chord {
    color: var(--accent);
  }
  .warn {
    color: var(--dirty);
  }
  .spacer {
    flex: 1;
  }
</style>
