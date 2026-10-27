<script lang="ts">
  import { comboFromEvent, formatSequence, isShortcutStart } from "../lib/keys";
  import { keyCapture } from "../lib/shortcut-editor.svelte";

  const request = $derived(keyCapture.request!);
  let combos: string[] = $state([]);
  let problem = $state("");

  function accept() {
    if (combos.length) request.resolve(combos.join(" "));
    else problem = "Press the new keys first.";
  }

  // Everything goes to this dialog while it is open: the keys are the input here, not commands.
  function onKeydown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    // Bare Enter, Escape and Backspace control the dialog; with a modifier they are keys like any other.
    if (combo === "escape") return request.resolve(null);
    if (combo === "enter") return accept();
    if (combo === "backspace") {
      combos = combos.slice(0, -1);
      problem = "";
      return;
    }
    if (combos.length === 1) {
      combos = [...combos, combo];
    } else if (isShortcutStart(combo)) {
      combos = [combo];
    } else {
      problem = "Use Ctrl, Alt or Win with the key, or a function key. Plain keys are for typing.";
      return;
    }
    problem = "";
  }

  function autofocus(node: HTMLElement) {
    node.focus();
  }
</script>

<svelte:window onkeydowncapture={onKeydown} />

<div class="backdrop">
  <div class="dialog capture" role="dialog" aria-modal="true">
    <p class="title">Shortcut for “{request.title}”</p>
    <div class="keys" class:empty={!combos.length}>
      {combos.length ? formatSequence(combos.join(" ")) : "Press the new keys…"}
    </div>
    <p class="hint" class:problem={!!problem}>
      {problem || "A second key makes a chord, like Ctrl+K Ctrl+C. Enter accepts, Backspace removes the last key, Esc cancels."}
    </p>
    <div class="buttons">
      <button onclick={() => request.resolve(null)}>Cancel</button>
      <button class="primary" use:autofocus onclick={accept}>Accept</button>
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
  .title {
    margin: 0 0 12px;
    font-size: 14px;
  }
  .keys {
    padding: 14px;
    text-align: center;
    font-size: 18px;
    font-family: var(--editor-font);
    background: var(--bg);
    border: 1px solid var(--accent);
    border-radius: 6px;
  }
  .keys.empty {
    color: var(--fg-dim);
    font-size: 14px;
    font-family: inherit;
  }
  .hint {
    margin: 10px 0 0;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .hint.problem {
    color: var(--error);
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
