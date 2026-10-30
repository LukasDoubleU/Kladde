// Grammar and spell checking with LanguageTool, shown through @codemirror/lint. This module and
// @codemirror/lint are imported lazily, the first time checking is switched on, so Kladde starts as
// light as before. The text logic (what to send, how to map the answer back) is in grammar-text.ts.
//
// Flow: after an edit (or a scroll) the linter waits a second, then asks for the paragraphs around the
// visible part. Paragraphs seen before come from a cache; only new ones go to the server, in one request
// within the size limit of the public API. A server that refuses or fails is left alone for a while
// (backoff), and the underlines already shown stay.

import {
  diagnosticCount,
  forEachDiagnostic,
  linter,
  setDiagnostics,
  type Action,
  type Diagnostic,
} from "@codemirror/lint";
import { StateEffect, type Extension, type Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { api } from "./api";
import {
  checkWindow,
  isPublicServer,
  markupFor,
  MatchCache,
  type Finding,
  type LtMatch,
  type Markup,
  type Request,
} from "./grammar-text";

export interface GrammarOptions {
  /** Markdown source: code, links and markers are left out. */
  markdown: boolean;
  /** A LanguageTool language code, or "auto". */
  language: string;
  /** The server address; empty means the local LanguageTool that Kladde runs. */
  server: string;
  /** Preferred variants for automatic detection, e.g. "en-US,de-DE". */
  variants: string;
}

export interface GrammarStatus {
  state: "checking" | "idle" | "limited" | "error";
  count: number;
  message?: string;
}

export interface GrammarHost {
  /** The options for the editor's current document, or null while checking is off for it. */
  options(view: EditorView): GrammarOptions | null;
  status(status: GrammarStatus): void;
  /** A failure began: tell the user once (the status keeps showing it). */
  failed(message: string): void;
}

/** Characters of text per request; the public API accepts 20,000. */
const BUDGET = 15_000;
/** How far beyond the visible part to check. */
const MARGIN = 4_000;
/** Documents above this are left alone: finding the markup would cost too much. */
const MAX_DOC = 2_000_000;
/** The public API allows 20 requests a minute; stay below. */
const PUBLIC_SPACING = 3_300;
const PUBLIC_PER_MINUTE = 18;
const PUBLIC_CHARS_PER_MINUTE = 70_000;

let host: GrammarHost | null = null;
const cache = new MatchCache();
const refresh = StateEffect.define<null>();

export function configureGrammar(h: GrammarHost) {
  host = h;
}

// ------------------------------------------------------------------ server politeness

/** Thrown instead of sending when the server must not be asked yet. */
class Wait extends Error {
  constructor(readonly ms: number) {
    super("waiting");
  }
}

interface CheckError {
  kind: "config" | "network" | "rate-limited" | "http" | "stopped";
  status?: number;
  retryAfter?: number;
  message: string;
}

const isCheckError = (e: unknown): e is CheckError => typeof e === "object" && e !== null && "kind" in e && "message" in e;

const gate = {
  until: 0,
  failures: 0,
  sent: [] as { at: number; chars: number }[],
  told: false,
  /** What the status says while the server is left alone after a failure. */
  failure: null as Pick<GrammarStatus, "state" | "message"> | null,
};

/** Forget failures and the request history, e.g. after the server setting changed. */
export function resetGrammar() {
  gate.until = 0;
  gate.failures = 0;
  gate.sent = [];
  gate.told = false;
  gate.failure = null;
  cache.clear();
}

function waitFor(server: string, chars: number): number {
  const now = Date.now();
  if (gate.until > now) return gate.until - now;
  if (!isPublicServer(server)) return 0;
  gate.sent = gate.sent.filter((s) => now - s.at < 60_000);
  const first = gate.sent[0];
  const last = gate.sent[gate.sent.length - 1];
  if (last && now - last.at < PUBLIC_SPACING) return last.at + PUBLIC_SPACING - now;
  const chars60 = gate.sent.reduce((n, s) => n + s.chars, 0);
  if (first && (gate.sent.length >= PUBLIC_PER_MINUTE || chars60 + chars > PUBLIC_CHARS_PER_MINUTE)) {
    return first.at + 60_000 - now;
  }
  return 0;
}

/** Seconds to stay away after the n-th failure in a row: 5, 10, 20 … up to five minutes. */
const backoff = (failures: number) => Math.min(300, 5 * 2 ** Math.max(0, failures - 1));

// ------------------------------------------------------------------ checking

const ignoredRules = new Set<string>();
const ignoredWords = new Set<string>();

let lastDoc: { doc: Text; markdown: boolean; markup: Markup[] } | null = null;
let retryTimer = 0;
let queue: Promise<unknown> = Promise.resolve();

const ignored = (f: Finding, text: string) =>
  f.kind === "spelling" ? ignoredWords.has(text.slice(f.from, f.to).toLowerCase()) : ignoredRules.has(f.rule);

function scheduleRetry(view: EditorView, ms: number) {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(() => requestRefresh(view), Math.max(ms, 300));
}

/** Runs the check again (after the linter's delay), e.g. when more paragraphs are due. */
export function requestRefresh(view: EditorView) {
  if (view.dom.isConnected) view.dispatch({ effects: refresh.of(null) });
}

async function run(view: EditorView): Promise<Diagnostic[]> {
  const options = host?.options(view);
  if (!host || !options) return [];
  const doc = view.state.doc;
  if (doc.length > MAX_DOC) {
    host.status({ state: "idle", count: 0, message: "The document is too large for grammar checking." });
    return [];
  }
  const text = doc.toString();
  if (!lastDoc || lastDoc.doc !== doc || lastDoc.markdown !== options.markdown) {
    lastDoc = { doc, markdown: options.markdown, markup: markupFor(text, options.markdown) };
  }
  const visible = view.visibleRanges;
  const shownFrom = visible.length ? visible[0].from : 0;
  const shownTo = visible.length ? visible[visible.length - 1].to : doc.length;

  let asked = false;
  const result = await checkWindow({
    text,
    markup: lastDoc.markup,
    from: Math.max(0, shownFrom - MARGIN),
    to: Math.min(doc.length, shownTo + MARGIN),
    focus: (shownFrom + shownTo) / 2,
    language: options.language,
    budget: BUDGET,
    cache,
    async check(request: Request): Promise<LtMatch[]> {
      const last = request.pieces[request.pieces.length - 1];
      const chars = last.start + last.chunk.to - last.chunk.from;
      const wait = waitFor(options.server, chars);
      if (wait > 0) throw new Wait(wait);
      asked = true;
      gate.sent.push({ at: Date.now(), chars });
      host!.status({ state: "checking", count: diagnosticCount(view.state) });
      const body = await api.languageToolCheck(options.server, request.data, options.language, options.variants);
      return (JSON.parse(body).matches ?? []) as LtMatch[];
    },
  });

  const findings = result.findings.filter((f) => !ignored(f, text));
  const count = findings.length;
  if (result.error === undefined) {
    if (asked) {
      gate.failures = 0;
      gate.told = false;
      gate.failure = null;
    }
    host.status({ state: "idle", count });
    if (result.remaining > 0) scheduleRetry(view, 400);
  } else if (result.error instanceof Wait) {
    // During the backoff after a failure the status keeps saying why; otherwise this is just the pacing of the public API.
    host.status(
      gate.failure && gate.until > Date.now()
        ? { ...gate.failure, count }
        : { state: "limited", count, message: `Waiting ${Math.ceil(result.error.ms / 1000)} s before asking the server again.` },
    );
    scheduleRetry(view, result.error.ms + 100);
  } else if (isCheckError(result.error) && result.error.kind === "stopped") {
    // The local server was stopped while the request waited for it (checking turned off, LanguageTool removed): no failure.
    host.status({ state: "idle", count });
  } else {
    const error = isCheckError(result.error) ? result.error : { kind: "network" as const, message: String(result.error) };
    gate.failures++;
    const seconds =
      error.kind === "rate-limited" ? Math.max(error.retryAfter ?? 0, backoff(gate.failures) * 2) : backoff(gate.failures);
    gate.until = Date.now() + seconds * 1000;
    const limited = error.kind === "rate-limited";
    const message = limited
      ? `The LanguageTool server is rate limiting requests. Trying again in ${seconds} s.`
      : `Grammar checking failed: ${error.message}`;
    gate.failure = { state: limited ? "limited" : "error", message };
    host.status({ ...gate.failure, count });
    if (!gate.told && !limited) {
      gate.told = true;
      host.failed(message);
    }
    scheduleRetry(view, seconds * 1000);
  }
  return findings.map((f) => diagnosticOf(f, text));
}

// ------------------------------------------------------------------ diagnostics

const label = (replacement: string) => (replacement === "" ? "Remove" : replacement.replace(/ /g, "·"));

function diagnosticOf(f: Finding, text: string): Diagnostic {
  const actions: Action[] = f.replacements.map((value) => ({
    name: label(value),
    apply: (view: EditorView, from: number, to: number) => {
      view.dispatch({ changes: { from, to, insert: value }, userEvent: "input.complete" });
    },
  }));
  const word = text.slice(f.from, f.to).toLowerCase();
  actions.push({
    name: f.kind === "spelling" ? "Ignore word" : "Ignore rule",
    apply: (view: EditorView) => {
      if (f.kind === "spelling") ignoredWords.add(word);
      else ignoredRules.add(f.rule);
      dropDiagnostics(view, (d) => (f.kind === "spelling" ? d.source === f.rule && wordOf(view, d) === word : d.source === f.rule));
    },
  });
  return {
    from: f.from,
    to: f.to,
    severity: f.kind === "spelling" ? "error" : f.kind === "grammar" ? "warning" : "info",
    message: f.message,
    source: f.rule,
    markClass: `cm-lt-${f.kind}`,
    actions,
  };
}

const wordOf = (view: EditorView, d: { from: number; to: number }) => view.state.sliceDoc(d.from, d.to).toLowerCase();

/** Removes the diagnostics matching `drop` right away; the next check would do it too, a second later. */
function dropDiagnostics(view: EditorView, drop: (d: Diagnostic) => boolean) {
  const keep: Diagnostic[] = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (!drop({ ...d, from, to })) keep.push({ ...d, from, to });
  });
  view.dispatch(setDiagnostics(view.state, keep));
  host?.status({ state: "idle", count: keep.length });
}

/** The number of findings shown for a state. */
export function grammarCount(view: EditorView): number {
  return diagnosticCount(view.state);
}

// ------------------------------------------------------------------ extension

const theme = EditorView.theme({
  ".cm-lintRange.cm-lt-spelling, .cm-lintRange.cm-lt-grammar, .cm-lintRange.cm-lt-style": {
    backgroundImage: "none",
    paddingBottom: 0,
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationThickness: "1px",
    textUnderlineOffset: "3px",
    textDecorationSkipInk: "none",
  },
  ".cm-lintRange.cm-lt-spelling": { textDecorationColor: "var(--lt-spelling)" },
  ".cm-lintRange.cm-lt-grammar": { textDecorationColor: "var(--lt-grammar)" },
  ".cm-lintRange.cm-lt-style": { textDecorationColor: "var(--lt-style)", textDecorationStyle: "dotted", textDecorationThickness: "2px" },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-alt)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.3)",
    fontFamily: "var(--ui-font)",
    fontSize: "13px",
    overflow: "hidden",
  },
  ".cm-diagnostic": { padding: "6px 10px", borderLeftWidth: "3px", maxWidth: "460px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--lt-spelling)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--lt-grammar)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--lt-style)" },
  ".cm-diagnosticAction": {
    font: "inherit",
    margin: "6px 6px 0 0",
    padding: "2px 8px",
    color: "var(--fg)",
    backgroundColor: "var(--bg-hover)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    cursor: "pointer",
  },
  ".cm-diagnosticAction:hover": { borderColor: "var(--accent)" },
  ".cm-diagnosticSource": { display: "block", marginTop: "4px", color: "var(--fg-dim)", fontSize: "11px" },
});

/** One linter for all tabs: the options come from the host each time it runs. */
export const grammarExtension: Extension = [
  linter(
    (view) => {
      const task = queue.then(() => run(view));
      queue = task.catch(() => {});
      return task;
    },
    {
      delay: 1000,
      needsRefresh: (update: ViewUpdate) => update.viewportChanged || update.transactions.some((t) => t.effects.some((e) => e.is(refresh))),
    },
  ),
  theme,
];
