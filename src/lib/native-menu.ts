// Which right clicks may show WebView2's own context menu.
//
// Its menu depends on what is under the pointer. On text you can edit it has Cut, Copy, Paste, spelling; anywhere
// else it is the page menu with Back, Forward, Refresh, Save as, Print and "Open link in new window". Refresh
// would reload Kladde (unsaved edits are only as safe as the last backup), Back/Forward and the link entries navigate
// the window. So the native menu stays only where the user types; everywhere else the page shows its own minimal menu
// (Copy, when there is a selection) or nothing.

const TEXT_INPUT = [
  "input:not([type])",
  ...["text", "search", "number", "password", "email", "url", "tel"].map((t) => `input[type="${t}"]`),
  "textarea",
]
  .map((s) => `${s}:not([readonly]):not([disabled])`)
  .join(", ");

/** Whether the target is a field the user can type into (a text input, a textarea, CodeMirror's content). */
export function keepsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest(TEXT_INPUT) !== null;
}

/** The selected text of the page or of the field under the pointer (a read-only field keeps it in the field). */
export function selectedText(target: EventTarget | null): string {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const { selectionStart: from, selectionEnd: to } = target;
    if (from !== null && to !== null && from !== to) return target.value.slice(from, to);
  }
  return window.getSelection()?.toString() ?? "";
}
