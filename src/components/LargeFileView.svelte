<script lang="ts">
  // Editor for files above the large file threshold. The document lives in Rust (a piece table over the
  // file, see large.rs); only the visible lines are fetched, so file size barely matters. Caret and
  // selection are line/column pairs (UTF-16 columns), text input goes through a hidden textarea, and
  // every edit is one call that Rust applies in place. Edits run one after another (`enqueue`), so a
  // fast typist never edits with positions that are already out of date.
  import type { Language } from "@codemirror/language";
  import { onMount, tick, untrack } from "svelte";
  import {
    api,
    type LargeChange,
    type LargeEdited,
    type LargeEditKind,
    type LargeLine,
    type LargeMatch,
  } from "../lib/api";
  import { writeText } from "../lib/clipboard";
  import { detectLanguage } from "../lib/languages";
  import {
    advance,
    charLeft,
    charRight,
    comparePos,
    flagSpans,
    leadingWhitespace,
    LINE_END,
    ordered,
    selectedLines,
    tabText,
    withCaret,
    wordAt,
    wordLeft,
    wordRight,
    type Pos,
    type Span,
  } from "../lib/large-edit";
  import { highlightLines, unitOffset } from "../lib/linehighlight";
  import { capturePointer } from "../lib/pointer";
  import { settings } from "../lib/settings.svelte";
  import { workspace, type Tab } from "../lib/workspace.svelte";

  let { tab }: { tab: Tab } = $props();
  const id = $derived(tab.largeId!);

  type ViewLine = LargeLine & { spans: Span[] };

  let total = $state(1);
  let done = $state(false);
  let topLine = $state(0);
  let lines: ViewLine[] = $state([]);
  let linesStart = $state(0);
  let height = $state(0);
  let match: LargeMatch | null = $state(null);

  let query = $state("");
  let matchCase = $state(false);
  let useRegex = $state(false);
  let searching = $state(false);
  let searchMessage = $state("");

  // Caret (head) and the other end of the selection (anchor).
  let anchor: Pos = $state({ line: 0, col: 0 });
  let head: Pos = $state({ line: 0, col: 0 });
  /** Column that Up/Down try to keep. */
  let goalCol: number | null = null;
  let focused = $state(false);
  /** Scroll the caret into view horizontally after the next render. */
  let revealPending = false;
  /** Bumped by every change of the document; lines fetched before it are stale. */
  let docRev = 0;
  let linesRev = -1;
  let seenRevision = untrack(() => tab.revision);

  let viewport: HTMLDivElement;
  let linesEl: HTMLDivElement;
  let body: HTMLDivElement;
  let input: HTMLTextAreaElement;
  let searchInput: HTMLInputElement;
  let gotoInput: HTMLInputElement;

  const lineHeight = $derived(Math.round((settings.fontSize + workspace.ui.zoom) * 1.5));
  const visible = $derived(Math.max(1, Math.ceil(height / lineHeight)));
  const maxTop = $derived(Math.max(0, total - visible + 1));
  const gutterChars = $derived(String(total).length + 1);
  const selection = $derived(ordered(anchor, head));
  const hasSelection = () => comparePos(anchor, head) !== 0;

  // The file grew (the periodic check updates the tab's size): keep showing the end if it was shown.
  let lastSize = untrack(() => tab.size);
  let followEnd = false;
  $effect(() => {
    const size = tab.size;
    untrack(() => {
      if (size > lastSize) followEnd = topLine >= maxTop;
      lastSize = size;
    });
  });

  // Counts the times the indexer was seen finished. The last line has no known end while it runs, so lines
  // fetched meanwhile lack it, and when the line count stays the same (a partly written last line gets
  // completed) nothing else would ask again.
  let indexedTick = $state(0);

  // Poll the background indexer until it has counted all lines; again after the file grew or changed.
  $effect(() => {
    const fileId = id;
    void tab.size;
    void tab.revision;
    let cancelled = false;
    const poll = async () => {
      try {
        const info = await api.largeInfo(fileId);
        if (cancelled) return;
        total = Math.max(1, info.lines);
        done = info.done;
        workspace.largeStatus = { lines: info.lines, done: info.done, size: info.size };
        if (followEnd) scrollTo(maxTop);
        if (info.done) {
          followEnd = false;
          indexedTick++;
        } else setTimeout(poll, 150);
      } catch {
        /* closed */
      }
    };
    void poll();
    return () => (cancelled = true);
  });

  // A reopened file (truncated or rotated) or deleted lines may end before the position.
  $effect(() => {
    if (topLine > maxTop) topLine = maxTop;
  });
  $effect(() => {
    if (head.line > total - 1 || anchor.line > total - 1) {
      const end = { line: total - 1, col: 0 };
      untrack(() => setSelection(end, end));
    }
  });
  $effect(() => {
    void id;
    match = null;
  });

  // Highlighting by the file's language, as far as it works line by line (e.g. log files).
  let parser = $state.raw<Language["parser"] | null>(null);
  $effect(() => {
    const desc = tab.path ? detectLanguage(tab.path, "") : null;
    parser = null;
    // Markdown depends on blocks that start above the window.
    if (!desc || desc.name === "Markdown") return;
    let stale = false;
    desc
      .load()
      .then((support) => {
        if (!stale) parser = support.language.parser;
      })
      .catch(() => {});
    return () => (stale = true);
  });

  function withSpans(result: LargeLine[], language: Language["parser"] | null): ViewLine[] {
    let spans: Span[][] | null = null;
    if (language) {
      try {
        spans = highlightLines(
          language,
          result.map((l) => l.text),
        );
      } catch {
        /* show plain text */
      }
    }
    return result.map((l, i) => ({ ...l, spans: spans?.[i] ?? [{ text: l.text, cls: "" }] }));
  }

  // Fetch the visible lines whenever the position, the line count, the document or the file changes.
  let request = 0;
  async function fetchLines() {
    if (tab.revision !== seenRevision) {
      seenRevision = tab.revision;
      docRev++;
    }
    const [fileId, start, count, language, rev, mine] = [id, topLine, visible + 1, parser, docRev, ++request];
    try {
      const result = await api.largeLines(fileId, start, count);
      if (mine !== request || rev !== docRev) return;
      lines = withSpans(result, language);
      linesStart = start;
      linesRev = rev;
    } catch {
      /* closed */
    }
  }
  $effect(() => {
    void [id, topLine, visible, total, indexedTick, tab.size, tab.revision, parser];
    untrack(() => void fetchLines());
  });

  /** A line of the document: from the screen if it is there and current, else from Rust. */
  async function lineAt(n: number): Promise<LargeLine> {
    const i = n - linesStart;
    if (linesRev === docRev && i >= 0 && i < lines.length) return lines[i];
    const [line] = await api.largeLines(id, n, 1);
    return line ?? { text: "", truncated: false };
  }

  /** The end of a line as a column: unknown (Rust finds it) for lines shortened for display. */
  const endCol = (line: LargeLine) => (line.truncated ? LINE_END : line.text.length);

  function scrollTo(line: number) {
    topLine = Math.max(0, Math.min(Math.round(line), maxTop));
  }

  /** Scrolls so that `line` is visible, about a third down from the top. */
  function reveal(line: number) {
    if (line < topLine || line >= topLine + visible - 1) scrollTo(line - Math.floor(visible / 3));
  }

  /** Scrolls just enough to show the caret's line. */
  function revealCaret() {
    if (head.line < topLine) scrollTo(head.line);
    else if (head.line > topLine + visible - 2) scrollTo(head.line - visible + 2);
    revealPending = true;
  }

  function setSelection(a: Pos, h: Pos, keepGoal = false) {
    anchor = a;
    head = h;
    if (!keepGoal) goalCol = null;
    revealCaret();
  }

  // The textarea follows the caret (for the IME window), and the caret stays in view horizontally.
  $effect(() => {
    void [head, lines];
    untrack(() => void tick().then(placeInput));
  });
  function placeInput() {
    const caret = viewport?.querySelector<HTMLElement>(".caret");
    if (!caret || !input) return;
    const box = body.getBoundingClientRect();
    let c = caret.getBoundingClientRect();
    if (revealPending) {
      revealPending = false;
      const v = viewport.getBoundingClientRect();
      const gutter = viewport.querySelector<HTMLElement>(".number")?.offsetWidth ?? 0;
      if (c.left < v.left + gutter + 4) viewport.scrollLeft -= v.left + gutter + 40 - c.left;
      else if (c.right > v.left + viewport.clientWidth - 4) viewport.scrollLeft += c.right - v.left - viewport.clientWidth + 40;
      c = caret.getBoundingClientRect();
    }
    input.style.left = `${c.left - box.left}px`;
    input.style.top = `${c.top - box.top}px`;
  }

  // The status bar shows the caret like for normal tabs.
  $effect(() => {
    const line = lines[head.line - linesStart];
    const col = Math.min(head.col, line?.text.length ?? head.col);
    workspace.cursor = { line: head.line + 1, col: col + 1, selected: 0, selections: 1, lines: total };
  });

  // ---------------------------------------------------------------- editing

  let queue: Promise<void> = Promise.resolve();
  /** Runs keyboard and editing work in order, each step on the results of the one before. */
  function enqueue(task: () => unknown) {
    queue = queue
      .then(task)
      .then(() => {})
      .catch((e) => workspace.showNotice("error", e instanceof Error ? e.message : String(e)));
  }

  function editable(): boolean {
    const why =
      tab.journal === "restoring"
        ? "Your unsaved changes from the last session are still being restored."
        : tab.journal === "conflict"
          ? "First decide what happens to your unsaved changes from the last session (see the bar above)."
          : !done
            ? "The file is still being indexed; editing works once that is done."
            : "";
    if (why) workspace.showNotice("info", why);
    return !why;
  }

  /** Bookkeeping after Rust changed the document. */
  function applied(result: LargeEdited) {
    docRev++;
    total = Math.max(1, result.lines);
    match = null;
    workspace.largeStatus = { lines: result.lines, done, size: result.size };
    workspace.largeEdited(tab, result.dirty);
  }

  async function apply(changes: LargeChange[], kind: LargeEditKind, caret: Pos | null, select?: [Pos, Pos]) {
    applied(await api.largeEdit(id, changes, kind));
    if (select) setSelection(select[0], select[1]);
    else if (caret) setSelection(caret, caret);
    await fetchLines();
  }

  async function replaceSelection(text: string, kind: LargeEditKind) {
    if (!editable()) return;
    const [from, to] = ordered(anchor, head);
    await apply([{ from, to, text }], kind, advance(from, text));
  }

  async function deleteBackward(word: boolean) {
    if (!editable()) return;
    if (hasSelection()) return replaceSelection("", "deleteBackward");
    const line = await lineAt(head.line);
    const col = Math.min(head.col, line.text.length);
    let from: Pos;
    if (col > 0) from = { line: head.line, col: word ? wordLeft(line.text, col) : charLeft(line.text, col) };
    else if (head.line > 0) from = { line: head.line - 1, col: endCol(await lineAt(head.line - 1)) };
    else return;
    await apply([{ from, to: { line: head.line, col }, text: "" }], "deleteBackward", from);
  }

  async function deleteForward(word: boolean) {
    if (!editable()) return;
    if (hasSelection()) return replaceSelection("", "deleteForward");
    const line = await lineAt(head.line);
    const at = { line: head.line, col: Math.min(head.col, line.text.length) };
    let to: Pos;
    if (at.col < line.text.length) to = { line: at.line, col: word ? wordRight(line.text, at.col) : charRight(line.text, at.col) };
    else if (line.truncated) to = { line: at.line, col: at.col + 1 };
    else if (at.line < total - 1) to = { line: at.line + 1, col: 0 };
    else return;
    await apply([{ from: at, to, text: "" }], "deleteForward", at);
  }

  /** Enter keeps the indentation of the line, like the editor. */
  async function newline() {
    const [from] = ordered(anchor, head);
    const line = await lineAt(from.line);
    await replaceSelection("\n" + leadingWhitespace(line.text).slice(0, from.col), "type");
  }

  async function undo(redo: boolean) {
    if (!editable()) return;
    const result = await api.largeUndo(id, redo);
    applied(result);
    if (result.caret) setSelection(result.caret, result.caret);
    await fetchLines();
  }

  const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
  const moved = (p: Pos, lines: number) => ({ line: p.line + lines, col: p.col });

  /** The text of whole lines, ending with a line break (for copying lines). */
  async function linesText(first: number, last: number) {
    return last < total - 1
      ? api.largeText(id, { line: first, col: 0 }, { line: last + 1, col: 0 })
      : (await api.largeText(id, { line: first, col: 0 }, { line: last, col: LINE_END })) + "\n";
  }

  async function deleteLines(first: number, last: number) {
    let from = { line: first, col: 0 };
    let to = { line: last + 1, col: 0 };
    // The last line takes the line break before it along.
    if (last >= total - 1) {
      from = first > 0 ? { line: first - 1, col: LINE_END } : from;
      to = { line: last, col: LINE_END };
    }
    const caret = { line: last < total - 1 ? first : Math.max(0, first - 1), col: 0 };
    await apply([{ from, to, text: "" }], "other", caret);
  }

  /** Copy (or cut) the selection; without one, the lines with the caret. */
  async function copy(cut: boolean) {
    if (!hasSelection()) {
      const { first, last } = selectedLines(anchor, head);
      await writeText(await linesText(first, last));
      if (cut && editable()) await deleteLines(first, last);
      return;
    }
    const [from, to] = ordered(anchor, head);
    await writeText(await api.largeText(id, from, to));
    if (cut && editable()) await apply([{ from, to, text: "" }], "other", from);
  }

  /** Editor commands (editor-actions.ts ids) that work here too, see LARGE_COMMANDS. */
  async function command(cmd: string) {
    const { first, last } = selectedLines(anchor, head);
    if (cmd === "editor.find") return focusSearch();
    if (cmd === "editor.findNext" || cmd === "editor.findPrevious") return void find(cmd === "editor.findNext");
    if (cmd === "editor.selectLine") {
      const end = last < total - 1 ? { line: last + 1, col: 0 } : { line: last, col: endCol(await lineAt(last)) };
      return setSelection({ line: first, col: 0 }, end);
    }
    if (!editable()) return;
    const block = () => api.largeText(id, { line: first, col: 0 }, { line: last, col: LINE_END }).then(normalize);
    const count = last - first + 1;
    switch (cmd) {
      case "edit.deleteLine":
        return deleteLines(first, last);
      case "editor.cutLine":
        await writeText(await linesText(first, last));
        return deleteLines(first, last);
      case "editor.duplicateLine": {
        const at = { line: last, col: LINE_END };
        return apply([{ from: at, to: at, text: "\n" + (await block()) }], "other", null, [moved(anchor, count), moved(head, count)]);
      }
      case "editor.copyLineUp": {
        const at = { line: first, col: 0 };
        return apply([{ from: at, to: at, text: (await block()) + "\n" }], "other", null, [anchor, head]);
      }
      case "editor.moveLineUp": {
        if (first === 0) return;
        const from = { line: first - 1, col: 0 };
        const text = normalize(await api.largeText(id, from, { line: last, col: LINE_END }));
        const cut = text.indexOf("\n");
        const swapped = text.slice(cut + 1) + "\n" + text.slice(0, cut);
        return apply([{ from, to: { line: last, col: LINE_END }, text: swapped }], "other", null, [moved(anchor, -1), moved(head, -1)]);
      }
      case "editor.moveLineDown": {
        if (last >= total - 1) return;
        const from = { line: first, col: 0 };
        const to = { line: last + 1, col: LINE_END };
        const text = normalize(await api.largeText(id, from, to));
        const cut = text.lastIndexOf("\n");
        const swapped = text.slice(cut + 1) + "\n" + text.slice(0, cut);
        return apply([{ from, to, text: swapped }], "other", null, [moved(anchor, 1), moved(head, 1)]);
      }
      case "editor.insertBlankLine": {
        const at = { line: head.line, col: LINE_END };
        return apply([{ from: at, to: at, text: "\n" }], "other", { line: head.line + 1, col: 0 });
      }
      case "editor.toUpperCase":
      case "editor.toLowerCase": {
        let [from, to] = ordered(anchor, head);
        if (!hasSelection()) {
          const [a, b] = wordAt((await lineAt(head.line)).text, head.col);
          [from, to] = [{ line: head.line, col: a }, { line: head.line, col: b }];
        }
        const text = normalize(await api.largeText(id, from, to));
        const next = cmd === "editor.toUpperCase" ? text.toUpperCase() : text.toLowerCase();
        if (next === text) return;
        const keep: [Pos, Pos] = hasSelection() ? [from, advance(from, next)] : [head, head];
        return apply([{ from, to, text: next }], "other", null, keep);
      }
    }
  }

  // ---------------------------------------------------------------- caret movement

  async function moveHorizontal(dir: -1 | 1, word: boolean, extend: boolean) {
    if (!extend && !word && hasSelection()) {
      const end = dir < 0 ? selection[0] : selection[1];
      return setSelection(end, end);
    }
    const line = await lineAt(head.line);
    let n = head.line;
    let col = Math.min(head.col, line.text.length);
    if (dir < 0) {
      if (col > 0) col = word ? wordLeft(line.text, col) : charLeft(line.text, col);
      else if (n > 0) col = endCol(await lineAt(--n));
    } else if (col < line.text.length) {
      col = word ? wordRight(line.text, col) : charRight(line.text, col);
    } else if (n < total - 1) {
      n++;
      col = 0;
    }
    const pos = { line: n, col };
    setSelection(extend ? anchor : pos, pos);
  }

  async function moveVertical(delta: number, extend: boolean) {
    const goal = goalCol ?? head.col;
    let pos: Pos;
    if (head.line + delta < 0) pos = { line: 0, col: 0 };
    else if (head.line + delta > total - 1) pos = { line: total - 1, col: endCol(await lineAt(total - 1)) };
    else {
      const line = await lineAt(head.line + delta);
      let col = Math.min(goal, line.truncated ? goal : line.text.length);
      // Not into the middle of a surrogate pair.
      if (col > 0 && col < line.text.length && line.text.charCodeAt(col) >= 0xdc00 && line.text.charCodeAt(col) <= 0xdfff) col--;
      pos = { line: head.line + delta, col };
    }
    setSelection(extend ? anchor : pos, pos, true);
    goalCol = goal;
  }

  /** Home goes to the end of the indentation first, then to the start of the line (like the editor). */
  async function lineHome(extend: boolean) {
    const indent = leadingWhitespace((await lineAt(head.line)).text).length;
    const pos = { line: head.line, col: head.col === indent ? 0 : indent };
    setSelection(extend ? anchor : pos, pos);
  }

  async function lineEnd(extend: boolean) {
    const pos = { line: head.line, col: endCol(await lineAt(head.line)) };
    setSelection(extend ? anchor : pos, pos);
  }

  async function documentEnd(extend: boolean) {
    const pos = { line: total - 1, col: endCol(await lineAt(total - 1)) };
    setSelection(extend ? anchor : pos, pos);
  }

  async function selectAll() {
    await documentEnd(false);
    anchor = { line: 0, col: 0 };
  }

  // ---------------------------------------------------------------- input

  function onKeydown(e: KeyboardEvent) {
    // Actions (window capture handler) and browser keys App.svelte swallowed are done with.
    if (e.defaultPrevented || e.isComposing || e.altKey || e.metaKey) return;
    const { ctrlKey: ctrl, shiftKey: shift, key } = e;
    const letter = key.length === 1 ? key.toLowerCase() : "";
    const page = Math.max(1, visible - 1);
    if (key === "ArrowLeft" || key === "ArrowRight") enqueue(() => moveHorizontal(key === "ArrowLeft" ? -1 : 1, ctrl, shift));
    else if ((key === "ArrowUp" || key === "ArrowDown") && ctrl) scrollTo(topLine + (key === "ArrowUp" ? -1 : 1));
    else if (key === "ArrowUp" || key === "ArrowDown") enqueue(() => moveVertical(key === "ArrowUp" ? -1 : 1, shift));
    else if (key === "PageUp" || key === "PageDown") {
      const delta = key === "PageUp" ? -page : page;
      scrollTo(topLine + delta);
      enqueue(() => moveVertical(delta, shift));
    } else if (key === "Home" && ctrl) {
      const start = { line: 0, col: 0 };
      enqueue(() => setSelection(shift ? anchor : start, start));
    } else if (key === "End" && ctrl) enqueue(() => documentEnd(shift));
    else if (key === "Home") enqueue(() => lineHome(shift));
    else if (key === "End") enqueue(() => lineEnd(shift));
    else if (key === "Backspace") enqueue(() => deleteBackward(ctrl));
    else if (key === "Delete") enqueue(() => deleteForward(ctrl));
    else if (key === "Enter" && !ctrl) enqueue(newline);
    else if (key === "Tab" && !ctrl) {
      if (!shift) enqueue(() => replaceSelection(tabText(head.col, settings.tabSize, settings.insertSpaces), "type"));
    } else if (key === "Escape") {
      if (searching) cancelSearch();
      else if (hasSelection()) enqueue(() => setSelection(head, head));
      else return;
    } else if (ctrl && letter === "a" && !shift) enqueue(selectAll);
    else if (ctrl && letter === "z" && !shift) enqueue(() => undo(false));
    else if (ctrl && (letter === "y" || (letter === "z" && shift))) enqueue(() => undo(true));
    else if (ctrl && letter === "c" && !shift) enqueue(() => copy(false));
    else if (ctrl && letter === "x" && !shift) enqueue(() => copy(true));
    // Ctrl+V goes on to the paste event; other keys are not ours.
    else return;
    e.preventDefault();
  }

  let composing = false;
  function onInput() {
    if (composing) return;
    const text = input.value;
    input.value = "";
    if (text) enqueue(() => replaceSelection(normalize(text), "type"));
  }

  function onCompositionEnd(e: CompositionEvent) {
    composing = false;
    input.value = "";
    if (e.data) enqueue(() => replaceSelection(e.data, "type"));
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const text = normalize(e.clipboardData?.getData("text/plain") ?? "");
    if (text) enqueue(() => replaceSelection(text, "other"));
  }

  // ---------------------------------------------------------------- mouse

  /** The text position under a point of the window. */
  function posFromPoint(x: number, y: number): Pos {
    const rect = linesEl.getBoundingClientRect();
    const line = Math.max(0, Math.min(total - 1, topLine + Math.floor((y - rect.top) / lineHeight)));
    const el = linesEl.querySelector<HTMLElement>(`.line[data-line="${line}"] .text`);
    const text = lines[line - linesStart]?.text ?? "";
    if (!el) return { line, col: 0 };
    const box = el.getBoundingClientRect();
    if (x <= box.left) return { line, col: 0 };
    if (x >= box.right) return { line, col: text.length };
    const hit = caretAt(x, box.top + box.height / 2);
    if (!hit || !el.contains(hit.node)) return { line, col: text.length };
    return { line, col: Math.min(text.length, textBefore(el, hit.node) + hit.offset) };
  }

  function caretAt(x: number, y: number): { node: Node; offset: number } | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }

  /** Characters of `root` before `node` (a text node, or an element whose children come next). */
  function textBefore(root: HTMLElement, node: Node): number {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n === node || node.contains(n)) break;
      count += n.textContent?.length ?? 0;
    }
    return count;
  }

  let dragging = false;
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    input.focus();
    const pos = posFromPoint(e.clientX, e.clientY);
    enqueue(async () => {
      if (e.detail === 2) {
        const [a, b] = wordAt((await lineAt(pos.line)).text, pos.col);
        return setSelection({ line: pos.line, col: a }, { line: pos.line, col: b });
      }
      if (e.detail >= 3) return setSelection({ line: pos.line, col: 0 }, { line: pos.line + 1, col: 0 });
      setSelection(e.shiftKey ? anchor : pos, pos);
    });
    if (e.detail > 1) return;
    dragging = true;
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", endDrag, { once: true });
  }

  function onDrag(e: MouseEvent) {
    if (!dragging) return;
    const rect = linesEl.getBoundingClientRect();
    // Past the top or bottom edge: scroll along.
    if (e.clientY < rect.top) scrollTo(topLine - 1);
    else if (e.clientY > rect.bottom) scrollTo(topLine + 1);
    const pos = posFromPoint(e.clientX, e.clientY);
    enqueue(() => {
      head = pos;
      goalCol = null;
    });
  }

  function endDrag() {
    dragging = false;
    window.removeEventListener("mousemove", onDrag);
  }

  onMount(() => {
    requestAnimationFrame(() => {
      if (!workspace.picker && !workspace.dialog && workspace.active?.id === tab.id) input?.focus();
    });
    return endDrag;
  });

  let wheelRest = 0;
  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    const px = e.deltaMode === 1 ? e.deltaY * lineHeight : e.deltaMode === 2 ? e.deltaY * height : e.deltaY;
    wheelRest += px / lineHeight;
    const step = Math.trunc(wheelRest);
    wheelRest -= step;
    if (step) scrollTo(topLine + step);
  }

  // Scrollbar: drawn by hand, because a native one cannot address millions of lines.
  let track: HTMLDivElement;
  const thumbHeight = $derived(Math.max(28, height * Math.min(1, visible / total)));
  const thumbTop = $derived(maxTop ? ((height - thumbHeight) * topLine) / maxTop : 0);
  let thumbDrag: { offset: number } | null = null;

  function onThumbDown(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    thumbDrag = { offset: e.clientY - track.getBoundingClientRect().top - thumbTop };
    capturePointer(e);
  }

  function onThumbMove(e: PointerEvent) {
    if (!thumbDrag) return;
    const y = e.clientY - track.getBoundingClientRect().top - thumbDrag.offset;
    scrollTo((y / Math.max(1, height - thumbHeight)) * maxTop);
  }

  function onTrackDown(e: PointerEvent) {
    const y = e.clientY - track.getBoundingClientRect().top;
    scrollTo(topLine + (y < thumbTop ? -1 : 1) * Math.max(1, visible - 1));
  }

  // ---------------------------------------------------------------- search

  /** Code points before a UTF-16 column (search positions count code points). */
  const codePoints = (text: string, col: number) => [...text.slice(0, col)].length;

  // Searches run in Rust; a newer search or a cancel stops the one before (it then reports `cancelled`).
  // They start at the caret and select what they find, so typing replaces it.
  let searchToken = 0;
  async function find(forward: boolean) {
    if (!query) return;
    const mine = ++searchToken;
    searching = true;
    searchMessage = "Searching…";
    try {
      const caretLine = lines[head.line - linesStart];
      const from = match ?? (caretLine ? { line: head.line, col: codePoints(caretLine.text, head.col) } : { line: topLine, col: 0 });
      let result = await api.largeSearch(id, query, from, forward, !match, matchCase, useRegex);
      if (mine !== searchToken || result.cancelled) return;
      let wrapped = false;
      if (!result.found) {
        const start = forward ? { line: 0, col: 0 } : { line: Number.MAX_SAFE_INTEGER, col: 0 };
        result = await api.largeSearch(id, query, start, forward, true, matchCase, useRegex);
        if (mine !== searchToken || result.cancelled) return;
        wrapped = !!result.found;
      }
      match = result.found;
      if (result.found) {
        const found = result.found;
        reveal(found.line);
        enqueue(() => selectMatch(found));
        searchMessage = wrapped ? "Wrapped around" : "";
      } else {
        searchMessage = "No results";
      }
    } catch (e) {
      if (mine === searchToken) searchMessage = String(e);
    } finally {
      if (mine === searchToken) searching = false;
    }
  }

  async function selectMatch(found: LargeMatch) {
    if (match !== found) return;
    const text = (await lineAt(found.line)).text;
    const from = unitOffset(text, found.col);
    anchor = { line: found.line, col: from };
    head = { line: found.line, col: from + unitOffset(text.slice(from), found.len) };
    goalCol = null;
  }

  function cancelSearch() {
    searchToken++;
    searching = false;
    searchMessage = "Search cancelled";
    void api.largeSearchCancel(id);
  }

  function searchOptionChanged() {
    match = null;
    searchMessage = "";
  }

  function focusSearch() {
    searchInput.focus();
    searchInput.select();
  }

  function gotoLine(line: number) {
    const target = { line: Math.max(0, Math.min(line - 1, total - 1)), col: 0 };
    match = null;
    anchor = head = target;
    goalCol = null;
    reveal(target.line);
    input.focus();
  }

  $effect(() => {
    workspace.largeApi = { gotoLine, focusSearch, run: (cmd) => enqueue(() => command(cmd)) };
    return () => (workspace.largeApi = null);
  });

  // ---------------------------------------------------------------- rendering

  /** The spans of a line with the search match, the selection and the caret. */
  function lineSpans(line: ViewLine, index: number): Span[] {
    let spans = line.spans;
    if (match && match.line === index) {
      const from = unitOffset(line.text, match.col);
      spans = flagSpans(spans, from, from + unitOffset(line.text.slice(from), match.len), "mark");
    }
    const [from, to] = selection;
    if (comparePos(from, to) !== 0 && index >= from.line && index <= to.line) {
      const a = index === from.line ? from.col : 0;
      const b = index === to.line ? to.col : line.text.length;
      spans = flagSpans(spans, a, Math.min(b, line.text.length), "sel");
    }
    if (index === head.line) spans = withCaret(spans, Math.min(head.col, line.text.length));
    return spans;
  }

  const classes = (s: Span) => [s.cls, s.sel ? "sel" : ""].filter(Boolean).join(" ");
</script>

<div class="large" class:focused>
  <div class="toolbar">
    <input
      bind:this={searchInput}
      bind:value={query}
      oninput={() => (match = null)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === "F3") void find(!e.shiftKey);
        else if (e.key === "Escape") {
          if (searching) cancelSearch();
          else input.focus();
        } else return;
        e.preventDefault();
      }}
      placeholder="Find (Enter / Shift+Enter)"
      spellcheck="false"
    />
    <button
      class="toggle"
      class:on={matchCase}
      aria-pressed={matchCase}
      title="Match case"
      onclick={() => {
        matchCase = !matchCase;
        searchOptionChanged();
      }}>Aa</button
    >
    <button
      class="toggle"
      class:on={useRegex}
      aria-pressed={useRegex}
      title="Regular expression"
      onclick={() => {
        useRegex = !useRegex;
        searchOptionChanged();
      }}>.*</button
    >
    <button title="Previous (Shift+F3)" onclick={() => find(false)}>↑</button>
    <button title="Next (F3)" onclick={() => find(true)}>↓</button>
    <span class="message">{searchMessage}</span>
    {#if searching}<button class="wide" title="Cancel the search (Esc)" onclick={cancelSearch}>Cancel</button>{/if}
    <span class="spacer"></span>
    <input
      class="goto"
      bind:this={gotoInput}
      placeholder="Go to line"
      inputmode="numeric"
      onkeydown={(e) => {
        if (e.key !== "Enter") return;
        const n = parseInt(gotoInput.value, 10);
        if (Number.isFinite(n)) gotoLine(n);
        gotoInput.value = "";
      }}
    />
    {#if !done}<span class="message">Indexing… {total.toLocaleString()} lines</span>{/if}
    <button
      class="wide"
      title={tab.size > workspace.largeEditLimit
        ? "Too large for the editor"
        : tab.dirty
          ? "Save or undo your changes first"
          : "Load the whole file into the editor (needs a lot of memory)"}
      disabled={tab.size > workspace.largeEditLimit || tab.dirty}
      onclick={() => workspace.openLargeInEditor(tab)}>Open in editor…</button
    >
  </div>

  <div class="body" bind:this={body}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="viewport"
      bind:this={viewport}
      bind:clientHeight={height}
      onwheel={onWheel}
      onfocus={() => input.focus()}
      tabindex="-1"
      role="document"
      style:--line-height="{lineHeight}px"
      style:--gutter="{gutterChars}ch"
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="lines" bind:this={linesEl} onmousedown={onMouseDown}>
        {#each lines as line, i (linesStart + i)}
          {@const index = linesStart + i}
          {@const spans = lineSpans(line, index)}
          <div class="line" class:active={index === head.line && settings.highlightActiveLine} data-line={index}>
            <span class="number">{index + 1}</span>
            <span class="text" class:eol={index >= selection[0].line && index < selection[1].line}
              >{#each spans as s}{#if s.caret}<span class="caret"></span>{:else if s.mark}<mark class={classes(s)}
                    >{s.text}</mark
                  >{:else if s.cls || s.sel}<span class={classes(s)}>{s.text}</span>{:else}{s.text}{/if}{/each}</span
            >{#if line.truncated}<span class="truncated" title="Line shortened for display">…</span>{/if}
          </div>
        {/each}
      </div>
    </div>
    <textarea
      bind:this={input}
      class="input"
      spellcheck="false"
      autocomplete="off"
      aria-label="Text input"
      onkeydown={onKeydown}
      oninput={onInput}
      onpaste={onPaste}
      oncompositionstart={() => (composing = true)}
      oncompositionend={onCompositionEnd}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
    ></textarea>
    <div class="track" bind:this={track} onpointerdown={onTrackDown} role="presentation">
      <div
        class="thumb"
        style:height="{thumbHeight}px"
        style:top="{thumbTop}px"
        onpointerdown={onThumbDown}
        onpointermove={onThumbMove}
        onpointerup={() => (thumbDrag = null)}
        role="presentation"
      ></div>
    </div>
  </div>
</div>

<style>
  .large {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
    flex: none;
  }
  .toolbar input:not([type="checkbox"]) {
    font: inherit;
    padding: 3px 6px;
    width: 260px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    outline: none;
  }
  .toolbar input:focus {
    border-color: var(--accent);
  }
  .toolbar input.goto {
    width: 110px;
  }
  .toolbar button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 3px;
    width: 26px;
    height: 24px;
  }
  .toolbar button.wide {
    width: auto;
    padding: 0 8px;
  }
  .toolbar button.toggle {
    color: var(--fg-dim);
  }
  .toolbar button.toggle.on {
    color: var(--fg);
    border-color: var(--accent);
    background: var(--active-line);
  }
  .toolbar button:disabled {
    opacity: 0.5;
  }
  .message {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
    position: relative;
  }
  .viewport {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    outline: none;
    font-family: var(--editor-font);
    font-size: var(--editor-font-size);
    font-variant-ligatures: var(--editor-ligatures);
    line-height: var(--line-height);
    cursor: text;
  }
  .lines {
    min-width: max-content;
    user-select: none;
  }
  .line {
    display: flex;
    height: var(--line-height);
    white-space: pre;
  }
  .line.active {
    background: var(--active-line);
  }
  .number {
    flex: none;
    width: var(--gutter);
    padding-right: 1ch;
    box-sizing: content-box;
    text-align: right;
    color: var(--fg-dim);
    border-right: 1px solid var(--border);
    margin-right: 6px;
    position: sticky;
    left: 0;
    background: var(--bg);
    cursor: default;
  }
  .active .number {
    color: var(--active-line-number);
  }
  .sel {
    background: var(--selection);
  }
  /* The selection goes on past the end of this line. */
  .text.eol::after {
    content: "";
    display: inline-block;
    width: 0.6ch;
    height: var(--line-height);
    vertical-align: top;
    background: var(--selection);
  }
  .caret {
    position: relative;
  }
  .caret::after {
    content: "";
    position: absolute;
    left: -1px;
    top: 0;
    height: var(--line-height);
    border-left: 2px solid var(--caret);
    visibility: hidden;
  }
  .focused .caret::after {
    visibility: visible;
    animation: blink 1.2s steps(1) infinite;
  }
  @keyframes blink {
    50% {
      visibility: hidden;
    }
  }
  mark {
    background: var(--search-match-selected);
    color: inherit;
    outline: 1px solid var(--search-match-border);
  }
  .truncated {
    color: var(--fg-dim);
    padding: 0 4px;
  }
  /* Receives typing, IME and paste at the caret's position, but is never seen. */
  .input {
    position: absolute;
    width: 1px;
    height: 1em;
    padding: 0;
    border: 0;
    margin: 0;
    opacity: 0;
    resize: none;
    overflow: hidden;
    white-space: pre;
    caret-color: transparent;
    pointer-events: none;
  }
  .track {
    width: 14px;
    flex: none;
    position: relative;
    background: var(--bg);
    border-left: 1px solid var(--border);
  }
  .thumb {
    position: absolute;
    left: 3px;
    right: 3px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--fg-dim) 45%, transparent);
  }
  .thumb:hover {
    background: var(--fg-dim);
  }
</style>
