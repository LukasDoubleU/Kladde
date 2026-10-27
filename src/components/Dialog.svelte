<script lang="ts">
  import { workspace } from "../lib/workspace.svelte";

  const request = $derived(workspace.dialog!);

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      const cancel = request.buttons.find((b) => b.id === "cancel") ?? request.buttons[request.buttons.length - 1];
      request.resolve(cancel.id);
    } else if (e.key === "Enter") {
      const primary = request.buttons.find((b) => b.primary) ?? request.buttons[0];
      request.resolve(primary.id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

<div class="backdrop">
  <div class="dialog" role="alertdialog" aria-modal="true">
    <p class="message">{request.message}</p>
    {#if request.detail}<p class="detail">{request.detail}</p>{/if}
    <div class="buttons">
      {#each request.buttons as button (button.id)}
        {#if button.primary}
          <button class="primary" use:autofocus onclick={() => request.resolve(button.id)}>{button.label}</button>
        {:else}
          <button onclick={() => request.resolve(button.id)}>{button.label}</button>
        {/if}
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgb(0 0 0 / 0.25);
    display: grid;
    place-items: center;
  }
  .dialog {
    width: min(440px, calc(100vw - 40px));
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
    margin: 0;
    color: var(--fg-dim);
  }
  .buttons {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  button {
    padding: 5px 14px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
  }
  button:hover {
    background: var(--bg-hover);
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-fg);
  }
</style>
