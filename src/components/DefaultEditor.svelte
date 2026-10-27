<script lang="ts">
  import { integration } from "../lib/integration.svelte";

  const setup = $derived(integration.setup);
  // Everything is preselected on the first run; afterwards the current registration is shown.
  let chosen: Record<string, boolean> = $state({});
  let contextMenu = $state(true);

  $effect(() => {
    if (!setup) return;
    const { status } = setup;
    chosen = Object.fromEntries(
      status.available.map((g) => [g.id, status.present ? status.groups.includes(g.id) : true]),
    );
    contextMenu = status.present ? status.contextMenu : true;
  });

  const groups = $derived(Object.keys(chosen).filter((id) => chosen[id]));
  const canContinue = $derived(groups.length > 0 || contextMenu);

  function onKeydown(e: KeyboardEvent) {
    if (!setup) return;
    if (e.key === "Escape") integration.closeSetup();
    else if (e.key === "Enter" && canContinue && (e.target as HTMLElement).tagName !== "BUTTON") {
      void integration.register(groups, contextMenu);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

{#if integration.offer}
  <div class="offer" role="region" aria-label="Default editor">
    <span>Make Kladde your default editor for text, Markdown and code files?</span>
    <button onclick={() => integration.openSetup()}>Choose file types…</button>
    <button onclick={() => (integration.offer = false)}>Not now</button>
    <button onclick={() => integration.dismissOffer()}>Don’t ask again</button>
  </div>
{/if}

<svelte:window onkeydowncapture={onKeydown} />

{#if setup}
  <div class="backdrop">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Default editor">
      <p class="message">Set Kladde as default editor</p>
      <p class="detail">
        Windows lets you choose default apps yourself. Kladde registers itself for the types below, then opens the
        Windows settings where you pick it.
      </p>
      <div class="options">
        {#each setup.status.available as group (group.id)}
          <label class="option">
            <input type="checkbox" bind:checked={chosen[group.id]} />
            <span>
              {group.label}
              <small>{group.extensions.map((e) => "." + e).join(" ")}</small>
            </span>
          </label>
        {/each}
        <label class="option">
          <input type="checkbox" bind:checked={contextMenu} />
          <span>
            “Edit with Kladde” in the Explorer context menu
            <small>on Windows 11 under “Show more options”</small>
          </span>
        </label>
      </div>
      <div class="buttons">
        <button onclick={() => integration.closeSetup()}>Cancel</button>
        <button
          class="primary"
          use:autofocus
          disabled={!canContinue}
          onclick={() => integration.register(groups, contextMenu)}
        >
          {groups.length ? "Register and open Windows settings" : "Add to context menu"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .offer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--banner);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .offer button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 2px 10px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.25);
    display: grid;
    place-items: center;
  }
  .dialog {
    width: min(520px, calc(100vw - 40px));
    max-height: calc(100vh - 40px);
    overflow: auto;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.35);
    padding: 18px 20px 14px;
  }
  .message {
    margin: 0 0 6px;
    font-size: 14px;
  }
  .detail {
    margin: 0 0 12px;
    color: var(--fg-dim);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .option {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .option input {
    margin-top: 3px;
  }
  small {
    display: block;
    color: var(--fg-dim);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .buttons button {
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
  }
  .buttons button:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .buttons button:disabled {
    opacity: 0.5;
  }
  .buttons button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
</style>
