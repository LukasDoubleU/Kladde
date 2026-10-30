// The open tabs and everything that happens to them: open, save, close, reload,
// encodings, external changes, the Markdown preview and the session (hot exit).
//
// One CodeMirror view is shared by all text tabs. Inactive tabs keep their
// EditorState (including undo history) in `runtime`, outside Svelte's reactivity.

import { EditorSelection, type EditorState, type StateEffect, Text } from "@codemirror/state";
import { EditorView, highlightActiveLine, type ViewUpdate } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, type Eol, type FileContent } from "./api";
import {
  activeLine,
  createEditorState,
  gutterExtension,
  grammar,
  gutters,
  indentation,
  indentationExtension,
  language,
  readOnly,
  spellCheckExtension,
  spelling,
  wrap,
} from "./editor";
import { minifyJson } from "./format";
import type { GrammarHost } from "./grammar";
import { frontMatterLanguage, isPublicServer, LANGUAGES, normalizeLanguage } from "./grammar-text";
import { formatterFor, formattableLanguages, formatWith, mapCursor, type Formatter } from "./formatters";
import { localLanguageTool as localLt } from "./languagetool-local.svelte";
import { allLanguages, detectLanguage, extensionOf, findLanguage, IMAGE_EXTENSIONS, isMarkdown } from "./languages";
import { dirname, renderMarkdown, renderSvg, resolvePath, setLanguageLoadedHandler } from "./markdown";
import { settings, updateSettingsFile } from "./settings.svelte";

export type TabKind = "text" | "large" | "image" | "compare" | "settings";
export type PreviewMode = "off" | "split" | "only";

export interface Tab {
  id: string;
  kind: TabKind;
  path: string | null;
  title: string;
  dirty: boolean;
  encoding: string;
  bom: boolean;
  eol: Eol;
  language: string | null;
  mtime: number;
  size: number;
  binary: boolean;
  lossy: boolean;
  preview: PreviewMode;
  largeId: number | null;
  /** The file changed or vanished on disk while the tab has unsaved changes. */
  external: "modified" | "deleted" | null;
  /** Bumped when a large tab's document changes without the view doing it (restored edits). */
  revision: number;
  /** A large tab's hot-exit journal: being applied, or made for a file that has changed since. */
  journal: "restoring" | "conflict" | null;
}

interface Runtime {
  state: EditorState | null;
  /** The document as last loaded or saved, to tell whether the tab is dirty. */
  saved: Text;
  /** Encoding or line ending changed: needs saving although the text is unchanged. */
  metaDirty: boolean;
  scrollTop: number;
  version: number;
  /** The version last written as a backup; -1 if never. */
  backedUp: number;
  /** Large tabs: the last file state seen on disk, and the one the user chose to ignore. */
  diskSeen?: string;
  diskIgnored?: string;
}

/** One side of a compare tab: a snapshot, not a live view of the tab or file. */
export interface CompareSide {
  label: string;
  text: string;
}

export interface CompareHandleLike {
  next(): void;
  previous(): void;
}

export interface PickItem {
  id: string;
  label: string;
  detail?: string;
}

interface PickerRequest {
  placeholder: string;
  items: PickItem[];
  /** Accept typed text that matches no item (e.g. a line number). */
  freeText?: boolean;
  resolve: (value: PickItem | string | null) => void;
}

interface DialogRequest {
  message: string;
  detail?: string;
  buttons: { id: string; label: string; primary?: boolean }[];
  resolve: (id: string) => void;
}

interface SessionTab {
  id: string;
  kind: TabKind;
  path: string | null;
  title: string;
  encoding: string;
  bom: boolean;
  eol: Eol;
  language: string | null;
  preview: PreviewMode;
  /** A LanguageTool language chosen for this tab; absent means the setting (or the front matter). */
  grammarLanguage?: string;
  hasBackup: boolean;
  cursor: number;
  scrollTop: number;
}

interface Session {
  version: 1;
  activeId: string | null;
  wordWrap: boolean;
  spellCheck?: boolean;
  grammarCheck?: boolean;
  zoom: number;
  tabs: SessionTab[];
}

function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return "a minute ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const ENCODINGS: PickItem[] = [
  { id: "UTF-8", label: "UTF-8" },
  { id: "UTF-8 BOM", label: "UTF-8 with BOM" },
  { id: "UTF-16LE", label: "UTF-16 LE", detail: "with BOM" },
  { id: "UTF-16BE", label: "UTF-16 BE", detail: "with BOM" },
  { id: "windows-1252", label: "Western (Windows 1252)", detail: "ANSI" },
  { id: "ISO-8859-15", label: "Western (ISO 8859-15)" },
  { id: "windows-1250", label: "Central European (Windows 1250)" },
  { id: "ISO-8859-2", label: "Central European (ISO 8859-2)" },
  { id: "windows-1251", label: "Cyrillic (Windows 1251)" },
  { id: "KOI8-R", label: "Cyrillic (KOI8-R)" },
  { id: "IBM866", label: "Cyrillic (DOS 866)" },
  { id: "windows-1253", label: "Greek (Windows 1253)" },
  { id: "windows-1254", label: "Turkish (Windows 1254)" },
  { id: "windows-1255", label: "Hebrew (Windows 1255)" },
  { id: "windows-1256", label: "Arabic (Windows 1256)" },
  { id: "windows-1257", label: "Baltic (Windows 1257)" },
  { id: "windows-1258", label: "Vietnamese (Windows 1258)" },
  { id: "windows-874", label: "Thai (Windows 874)" },
  { id: "Shift_JIS", label: "Japanese (Shift JIS)" },
  { id: "EUC-JP", label: "Japanese (EUC-JP)" },
  { id: "GBK", label: "Chinese Simplified (GBK)" },
  { id: "gb18030", label: "Chinese Simplified (GB18030)" },
  { id: "Big5", label: "Chinese Traditional (Big5)" },
  { id: "EUC-KR", label: "Korean (EUC-KR)" },
  { id: "macintosh", label: "Western (Mac Roman)" },
];

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

function newId(): string {
  return crypto.randomUUID();
}

/** The smallest change that turns `a` into `b`, so a reload keeps cursor and scroll position. */
function minimalChange(a: string, b: string) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/** GitHub-flavoured Markdown with highlighted fenced code blocks. */
async function markdownSupport() {
  const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
  return markdown({ base: markdownLanguage, codeLanguages: allLanguages });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** localStorage key: the user agreed to send text to the public LanguageTool server. */
const PUBLIC_SERVER_CONSENT = "kladde.languageToolPublicServer";
const PUBLIC_SERVER = "https://api.languagetool.org";

class Workspace {
  tabs: Tab[] = $state([]);
  activeId: string | null = $state(null);
  cursor = $state({ line: 1, col: 1, selected: 0, selections: 1, lines: 1 });
  largeStatus = $state({ lines: 0, done: false, size: 0 });
  previewHtml = $state("");
  ui = $state({ wordWrap: false, spellCheck: false, grammarCheck: false, zoom: 0 });
  /** Grammar checking of the shown tab, for the status bar. "off": not running for this tab. */
  grammar = $state({ state: "off" as "off" | "checking" | "idle" | "limited" | "error", count: 0, message: "" });
  notice: { kind: "info" | "error"; text: string } | null = $state(null);
  picker: PickerRequest | null = $state(null);
  dialog: DialogRequest | null = $state(null);

  view: EditorView | null = null;
  /** The controls of the compare views (shared by all compare tabs, not persisted). */
  compareOptions = $state({ ignoreWhitespace: false, ignoreCase: false, unified: false });
  /** Number of changes per compare tab id. */
  compareChanges: Record<string, number> = $state({});
  /** Set by the large file view of the active tab. */
  largeApi: { gotoLine(line: number): void; focusSearch(): void; run(command: string): void } | null = null;
  onConfigSaved: (path: string) => void = () => {};

  private runtime = new Map<string, Runtime>();
  /** The LanguageTool language per tab id, where it differs from the setting. */
  private grammarLanguages = new Map<string, string>();
  private grammarModule: typeof import("./grammar") | null = null;
  private grammarKey = "";
  private grammarConsent: Promise<boolean> | null = null;
  private compareData = new Map<string, { left: CompareSide; right: CompareSide }>();
  private compareHandles = new Map<string, CompareHandleLike>();
  private closedPaths: string[] = [];
  /** Recently activated tabs, for back/forward navigation like in a browser. */
  private history: string[] = [];
  private historyIndex = -1;
  private navigating = false;
  private previewTimer = 0;
  private sessionTimer = 0;
  private noticeTimer = 0;
  private sessionChain: Promise<void> = Promise.resolve();
  private restored = false;

  constructor() {
    setLanguageLoadedHandler(() => this.renderPreview());
  }

  get active(): Tab | undefined {
    return this.tabs.find((t) => t.id === this.activeId);
  }

  // ---------------------------------------------------------------- editor

  attachView(parent: HTMLElement) {
    this.view = new EditorView({ parent, state: this.newState("") });
    this.view.scrollDOM.addEventListener("scroll", () => this.onEditorScroll(), { passive: true });
  }

  private editorExtras() {
    return [
      EditorView.updateListener.of((update) => this.onUpdate(update)),
      EditorView.domEventHandlers({ paste: (event) => this.onPaste(event) }),
    ];
  }

  private newState(doc: string, readOnlyDoc = false): EditorState {
    return createEditorState(
      doc,
      {
        wordWrap: this.ui.wordWrap,
        tabSize: settings.tabSize,
        insertSpaces: settings.insertSpaces,
        lineNumbers: settings.lineNumbers,
        highlightActiveLine: settings.highlightActiveLine,
        readOnly: readOnlyDoc,
        spellCheck: this.ui.spellCheck,
      },
      this.editorExtras(),
    );
  }

  private stateOf(tab: Tab): EditorState | null {
    if (tab.id === this.activeId && this.view && tab.kind === "text") return this.view.state;
    return this.runtime.get(tab.id)?.state ?? null;
  }

  textOf(tab: Tab): string {
    return this.stateOf(tab)?.doc.toString() ?? "";
  }

  private onUpdate(update: ViewUpdate) {
    const tab = this.active;
    if (!tab || tab.kind !== "text") return;
    if (update.docChanged) {
      const rt = this.runtime.get(tab.id)!;
      rt.version++;
      const dirty = rt.metaDirty || !this.isSaved(rt, update.state.doc);
      if (tab.dirty !== dirty) tab.dirty = dirty;
      this.schedulePreview();
      this.scheduleSession();
    }
    if (update.docChanged || update.selectionSet) this.updateCursor(update.state);
  }

  private isSaved(rt: Runtime, doc: Text): boolean {
    return rt.saved.length === doc.length && rt.saved.eq(doc);
  }

  private updateCursor(state: EditorState) {
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    this.cursor = {
      line: line.number,
      col: main.head - line.from + 1,
      selected: state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0),
      selections: state.selection.ranges.length,
      lines: state.doc.lines,
    };
  }

  /** Applies view-wide options (wrap, indentation, gutters) to the active editor state. */
  applyViewOptions() {
    if (!this.view) return;
    this.view.dispatch({
      effects: [
        wrap.reconfigure(this.ui.wordWrap ? EditorView.lineWrapping : []),
        indentation.reconfigure(indentationExtension(settings.tabSize, settings.insertSpaces)),
        gutters.reconfigure(gutterExtension(settings.lineNumbers)),
        activeLine.reconfigure(settings.highlightActiveLine ? highlightActiveLine() : []),
        spelling.reconfigure(spellCheckExtension(this.ui.spellCheck)),
      ],
    });
    void this.applyGrammar();
  }

  // ---------------------------------------------------------------- grammar checking

  /** Markdown and plain text, or every text file with the languageToolAllFiles setting. */
  private grammarEligible(tab: Tab | undefined): boolean {
    return !!tab && tab.kind === "text" && (settings.languageToolAllFiles || tab.language === null || isMarkdown(tab.language));
  }

  private grammarHost: GrammarHost = {
    options: (view) => {
      const tab = this.active;
      // An empty server is the local LanguageTool, once it is installed.
      const server = settings.languageToolServer.trim();
      if (!tab || view !== this.view || (!server && !localLt.installed) || !this.ui.grammarCheck || !this.grammarEligible(tab)) return null;
      // The public server only ever gets text after the user agreed (see confirmGrammarServer).
      if (isPublicServer(server) && localStorage.getItem(PUBLIC_SERVER_CONSENT) !== "1") return null;
      const markdown = isMarkdown(tab.language);
      const language =
        this.grammarLanguages.get(tab.id) ??
        (markdown ? frontMatterLanguage(view.state.sliceDoc(0, 4000)) : null) ??
        normalizeLanguage(settings.languageToolLanguage) ??
        "auto";
      return { markdown, language, server, variants: settings.languageToolVariants.trim() };
    },
    status: (status) => {
      this.grammar = { state: status.state, count: status.count, message: status.message ?? "" };
    },
    failed: (message) => this.showNotice("error", message),
  };

  /** The one-time warning before text goes to the public LanguageTool server. */
  private confirmGrammarServer(server: string): Promise<boolean> {
    if (!isPublicServer(server) || localStorage.getItem(PUBLIC_SERVER_CONSENT) === "1") return Promise.resolve(true);
    this.grammarConsent ??= this.ask(
      "Send your text to the public LanguageTool server?",
      [
        { id: "send", label: "Send text", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      "Grammar checking sends the paragraphs around the visible part of the document to " +
        "api.languagetool.org, a server run by a third party. Do not use it for confidential text. " +
        "The local LanguageTool, which Kladde can download for you, keeps everything on your machine.",
    ).then((choice) => {
      this.grammarConsent = null;
      if (choice === "send") localStorage.setItem(PUBLIC_SERVER_CONSENT, "1");
      return choice === "send";
    });
    return this.grammarConsent;
  }

  /** Brings the editor in line with the grammar settings and the shown tab; loads LanguageTool support on first use. */
  private async applyGrammar() {
    const view = this.view;
    const tab = this.active;
    if (!view) return;
    const server = settings.languageToolServer.trim();
    if (!this.ui.grammarCheck || !this.grammarEligible(tab)) {
      if (this.grammarModule) view.dispatch({ effects: grammar.reconfigure([]) });
      this.grammar = { state: "off", count: 0, message: "" };
      return;
    }
    if (!server) {
      // The local LanguageTool: this also covers a start with grammar checking on after it was removed. Nothing is
      // downloaded without asking, so checking stays off until the toggle command offers it again.
      if (!(localLt.info ?? (await localLt.refresh()))?.installed) {
        this.ui.grammarCheck = false;
        this.scheduleSession();
        void this.applyGrammar();
        this.showNotice("info", "Grammar checking is off: the local LanguageTool is not installed. Turn it on to download it.");
        return;
      }
    } else if (localLt.server !== "stopped") {
      // A server of the user's own now: the one Kladde ran is not needed any more.
      void localLt.stop();
    }
    if (!(await this.confirmGrammarServer(server))) {
      this.ui.grammarCheck = false;
      this.scheduleSession();
      void this.applyGrammar();
      return;
    }
    const module = (this.grammarModule ??= await import("./grammar"));
    if (this.view !== view || this.active !== tab || !this.ui.grammarCheck) return;
    module.configureGrammar(this.grammarHost);
    const key = [server, settings.languageToolLanguage, settings.languageToolVariants].join("\n");
    const changed = key !== this.grammarKey;
    if (changed) {
      this.grammarKey = key;
      module.resetGrammar();
    }
    view.dispatch({ effects: grammar.reconfigure(module.grammarExtension) });
    this.grammar = { state: "idle", count: module.grammarCount(view), message: "" };
    if (changed) module.requestRefresh(view);
  }

  async toggleGrammarCheck() {
    if (this.ui.grammarCheck) {
      this.ui.grammarCheck = false;
      this.applyViewOptions();
      void localLt.stop();
      this.showNotice("info", "Grammar checking off.");
      this.scheduleSession();
      return;
    }
    if (!settings.languageToolServer.trim() && !(await localLt.refresh())?.installed && !(await this.offerLanguageTool())) {
      return;
    }
    this.ui.grammarCheck = true;
    await this.applyGrammar();
    if (!this.ui.grammarCheck) return;
    this.scheduleSession();
    this.showNotice(
      "info",
      this.grammarEligible(this.active)
        ? "Grammar checking on."
        : "Grammar checking on. It checks Markdown and plain text; set languageToolAllFiles for other files.",
    );
  }

  /**
   * Grammar checking was asked for without a server and without the local LanguageTool: offer to download it, use
   * the public API (after its confirmation) or give up. True when checking can go on.
   */
  private async offerLanguageTool(): Promise<boolean> {
    const choice = await this.ask(
      "Grammar checking needs LanguageTool.",
      [
        { id: "download", label: "Download (about 300 MB)", primary: true },
        { id: "public", label: "Use the public API" },
        { id: "cancel", label: "Cancel" },
      ],
      "Kladde can download LanguageTool and a Java runtime once (about 300 MB, 570 MB on disk) and run them on " +
        "your computer: after the download nothing leaves your machine. The public API at api.languagetool.org is " +
        "run by a third party and receives your text. For a server of your own, set languageToolServer on the " +
        "settings page (Ctrl+Alt+S).",
    );
    if (choice === "download") return this.downloadLocalLanguageTool();
    if (choice !== "public" || !(await this.confirmGrammarServer(PUBLIC_SERVER))) return false;
    const error = await updateSettingsFile({ languageToolServer: PUBLIC_SERVER });
    if (error) this.showNotice("error", error);
    return !error;
  }

  /** Downloads and installs the local LanguageTool (progress in the status bar); true when it is installed. */
  async downloadLocalLanguageTool(): Promise<boolean> {
    if (localLt.busy) {
      this.showNotice("info", "LanguageTool is already being downloaded.");
      return false;
    }
    if ((await localLt.refresh())?.installed) {
      this.showNotice("info", "The local LanguageTool is already installed.");
      return true;
    }
    const result = await localLt.install();
    if (result.ok) this.showNotice("info", "LanguageTool is installed.");
    else if (result.cancelled) this.showNotice("info", "The download was cancelled. Nothing was installed.");
    else this.showNotice("error", `Could not download LanguageTool: ${result.message}`);
    return result.ok;
  }

  /** Deletes the local LanguageTool after asking; grammar checking that depended on it goes off. */
  async removeLocalLanguageTool() {
    const info = await localLt.refresh();
    if (!info?.installed) {
      this.showNotice("info", "The local LanguageTool is not installed.");
      return;
    }
    const mb = Math.round(info.size / 1_000_000);
    const choice = await this.ask(
      "Remove the local LanguageTool?",
      [
        { id: "remove", label: "Remove", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      `This deletes LanguageTool and its Java runtime (${mb} MB) from Kladde's data folder. You can download them again.`,
    );
    if (choice !== "remove") return;
    const error = await localLt.remove();
    if (error) {
      this.showNotice("error", `Could not remove LanguageTool: ${error}`);
      return;
    }
    if (this.ui.grammarCheck && !settings.languageToolServer.trim()) {
      this.ui.grammarCheck = false;
      this.applyViewOptions();
      this.scheduleSession();
    }
    this.showNotice("info", "The local LanguageTool was removed.");
  }

  /** Picks the LanguageTool language of the shown tab (otherwise: the setting, or the front matter of Markdown). */
  async setGrammarLanguage() {
    const tab = this.active;
    if (!tab || tab.kind !== "text") return;
    const current = this.grammarLanguages.get(tab.id) ?? "";
    const items = [
      { id: "", label: `Default (${settings.languageToolLanguage})`, detail: current === "" ? "current" : "" },
      ...LANGUAGES.map((l) => ({ id: l.id, label: l.label, detail: l.id === current ? "current" : l.id })),
    ];
    const picked = await this.pick({ placeholder: "Grammar checking language (or type a code such as de-DE)", items, freeText: true });
    if (picked === null || this.active !== tab) return;
    const id = typeof picked === "string" ? normalizeLanguage(picked) : picked.id;
    if (id === null) {
      this.showNotice("error", `"${picked}" is not a language code. Use a code such as en-US or de-DE.`);
      return;
    }
    if (id === "") this.grammarLanguages.delete(tab.id);
    else this.grammarLanguages.set(tab.id, id);
    this.scheduleSession();
    if (this.ui.grammarCheck && this.view) this.grammarModule?.requestRefresh(this.view);
    else this.showNotice("info", "Grammar checking is off; the language applies once you turn it on.");
  }

  private reconfigure(tab: Tab, effects: StateEffect<unknown> | StateEffect<unknown>[]) {
    if (tab.id === this.activeId && this.view) {
      this.view.dispatch({ effects });
    } else {
      const rt = this.runtime.get(tab.id);
      if (rt?.state) rt.state = rt.state.update({ effects }).state;
    }
  }

  /** The CodeMirror extension of a language; for the editor and the compare views. */
  private languageSupport(desc: NonNullable<ReturnType<typeof findLanguage>>) {
    return isMarkdown(desc.name) ? markdownSupport() : desc.load();
  }

  async languageExtension(name: string | null) {
    const desc = findLanguage(name);
    if (!desc) return [];
    try {
      return await this.languageSupport(desc);
    } catch {
      return [];
    }
  }

  private async loadLanguage(tab: Tab) {
    const desc = findLanguage(tab.language);
    if (!desc) {
      this.reconfigure(tab, language.reconfigure([]));
      return;
    }
    try {
      const support = await this.languageSupport(desc);
      if (this.tabs.some((t) => t.id === tab.id) && tab.language === desc.name) {
        this.reconfigure(tab, language.reconfigure(support));
      }
    } catch (e) {
      this.showNotice("error", `Could not load highlighting for ${desc.name}: ${e}`);
    }
  }

  setLanguage(tab: Tab, name: string | null) {
    tab.language = name;
    if (isMarkdown(name) && tab.preview === "off") tab.preview = settings.markdownPreview;
    if (!this.previewAvailable(tab)) tab.preview = "off";
    void this.loadLanguage(tab);
    void this.applyGrammar();
    this.renderPreview();
    this.scheduleSession();
  }

  // ---------------------------------------------------------------- tabs

  activate(id: string) {
    const prev = this.active;
    if (prev && prev.id !== id && prev.kind === "text" && this.view) {
      const rt = this.runtime.get(prev.id);
      if (rt) {
        rt.state = this.view.state;
        rt.scrollTop = this.view.scrollDOM.scrollTop;
      }
    }
    this.activeId = id;
    const tab = this.active;
    if (!tab) return;
    if (!this.navigating && this.history[this.historyIndex] !== id) {
      this.history.splice(this.historyIndex + 1, Infinity, id);
      if (this.history.length > 100) this.history.shift();
      this.historyIndex = this.history.length - 1;
    }
    if (tab.kind === "text" && this.view) {
      const rt = this.runtime.get(id)!;
      if (this.view.state !== rt.state) {
        this.view.setState(rt.state!);
        this.applyViewOptions();
        const top = rt.scrollTop;
        requestAnimationFrame(() => {
          if (this.view && this.activeId === id) this.view.scrollDOM.scrollTop = top;
        });
      }
      this.updateCursor(this.view.state);
      // Not when a palette or dialog opened meanwhile: it holds the focus now.
      requestAnimationFrame(() => {
        if (this.activeId === id && tab.preview !== "only" && !this.picker && !this.dialog) this.view?.focus();
      });
    }
    this.renderPreview();
    this.scheduleSession();
  }

  private addTab(tab: Tab, rt?: Runtime) {
    if (rt) this.runtime.set(tab.id, rt);
    else this.runtime.set(tab.id, { state: null, saved: Text.empty, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
    // Like Notepad++: an untouched empty "new" tab gets replaced by the opened file.
    const current = this.active;
    const replace =
      current && current.kind === "text" && !current.path && !current.dirty && this.textOf(current) === "";
    this.tabs.push(tab);
    this.activate(tab.id);
    if (replace) this.removeTab(current.id);
  }

  private untitledTitle(): string {
    const used = new Set(this.tabs.filter((t) => !t.path).map((t) => t.title));
    let n = 1;
    while (used.has(`new ${n}`)) n++;
    return `new ${n}`;
  }

  private textTab(fields: Partial<Tab> & { id?: string }): Tab {
    return {
      kind: "text",
      path: null,
      title: "",
      dirty: false,
      encoding: "UTF-8",
      bom: false,
      eol: "CRLF",
      language: null,
      mtime: 0,
      size: 0,
      binary: false,
      lossy: false,
      preview: "off",
      largeId: null,
      external: null,
      revision: 0,
      journal: null,
      ...fields,
      // After the spread: callers may pass `id: undefined`.
      id: fields.id ?? newId(),
    };
  }

  newUntitled() {
    const tab = this.textTab({ title: this.untitledTitle() });
    const state = this.newState("");
    this.runtime.set(tab.id, { state, saved: state.doc, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
    this.tabs.push(tab);
    this.activate(tab.id);
  }

  private createText(path: string, content: FileContent, id?: string): Tab {
    const firstLine = content.text.slice(0, 300).split("\n")[0];
    const lang = detectLanguage(path, firstLine)?.name ?? null;
    return this.textTab({
      id,
      path,
      title: basename(path),
      encoding: content.encoding,
      bom: content.bom,
      eol: content.eol,
      language: lang,
      mtime: content.mtime,
      size: content.size,
      binary: content.binary,
      lossy: content.lossy,
      preview: isMarkdown(lang) ? settings.markdownPreview : "off",
    });
  }

  async openPath(path: string) {
    const existing = this.tabs.find((t) => t.path && samePath(t.path, path));
    if (existing) {
      this.activate(existing.id);
      return;
    }
    try {
      const stat = await api.statFile(path);
      if (!stat.exists) throw new Error("The file does not exist.");
      if (!stat.isFile) throw new Error("This is a folder, not a file.");
      const ext = extensionOf(path);
      if (IMAGE_EXTENSIONS.has(ext)) {
        this.addTab(this.textTab({ kind: "image", path, title: basename(path), mtime: stat.mtime, size: stat.size }));
      } else if (stat.size > settings.largeFileThresholdMB * 1024 * 1024) {
        await this.openLarge(path);
      } else {
        const content = await api.readFile(path);
        const tab = this.createText(path, content);
        const state = this.newState(content.text);
        this.addTab(tab, { state, saved: state.doc, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
        void this.loadLanguage(tab);
        if (content.lossy) this.showNotice("info", `${tab.title}: some bytes are not valid ${content.encoding}.`);
      }
    } catch (e) {
      this.showNotice("error", `Could not open ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async openLarge(path: string, id?: string) {
    const opened = await api.largeOpen(path);
    const tab = this.textTab({
      id,
      kind: "large",
      path,
      title: basename(path),
      encoding: opened.encoding,
      bom: opened.bom,
      eol: opened.eol,
      mtime: opened.mtime,
      size: opened.size,
      largeId: opened.id,
    });
    this.addTab(tab);
  }

  /** Opens the file again in the same tab, e.g. after it was truncated, replaced or rotated. Unsaved edits are dropped. */
  private async reopenLarge(tab: Tab) {
    if (!tab.path) return;
    try {
      const opened = await api.largeOpen(tab.path);
      const old = tab.largeId;
      Object.assign(tab, {
        largeId: opened.id,
        encoding: opened.encoding,
        bom: opened.bom,
        eol: opened.eol,
        mtime: opened.mtime,
        size: opened.size,
        external: null,
        dirty: false,
        journal: null,
      });
      const rt = this.runtime.get(tab.id);
      if (rt) rt.diskIgnored = undefined;
      if (old !== null) void api.largeClose(old);
      this.scheduleSession();
    } catch (e) {
      this.showNotice("error", `Could not reload ${tab.title}: ${e}`);
    }
  }

  private refreshingLarge = new Set<string>();

  /**
   * A large file's size or time changed on disk. Appended data extends the viewer's index in place (the
   * view follows the end like `tail -f`); a shorter or rewritten file is reopened.
   */
  private async refreshLarge(tab: Tab, stat: { size: number; mtime: number }) {
    if (tab.largeId === null || this.refreshingLarge.has(tab.id)) return;
    this.refreshingLarge.add(tab.id);
    try {
      const result = await api.largeRefresh(tab.largeId);
      // The open handle sees growth and truncation of its own file. A file that was renamed away and
      // replaced shows up as a path that no longer matches the handle: it is bigger than the handle's
      // file (the stat came first, so the handle can only be ahead when the same file grew), or equally
      // big with another time.
      const replaced = result.size < stat.size || (result.size === stat.size && result.mtime !== stat.mtime);
      // Edits made while this was running are not dropped; the next check warns about the file instead.
      if (tab.dirty || tab.journal) return;
      if (result.changed || replaced) await this.reopenLarge(tab);
      else if (this.tabs.includes(tab)) {
        tab.mtime = result.mtime;
        tab.size = result.size;
      }
    } catch {
      /* closed meanwhile */
    } finally {
      this.refreshingLarge.delete(tab.id);
    }
  }

  /** Largest file that "Open in editor" accepts: the editor holds the text several times in memory. */
  readonly largeEditLimit = 256 * 1024 * 1024;

  /** Opens a large file in a normal editor tab, in place of the viewer. */
  async openLargeInEditor(tab: Tab | undefined = this.active) {
    if (!tab || tab.kind !== "large" || !tab.path) return;
    const mb = Math.round(tab.size / (1024 * 1024));
    if (tab.size > this.largeEditLimit) {
      this.showNotice("error", `${tab.title} is too large for the editor (${mb} MB, limit ${this.largeEditLimit / 1048576} MB).`);
      return;
    }
    if (tab.dirty || tab.journal) {
      this.showNotice("info", `Save or undo your changes to ${tab.title} first; the editor loads the file from disk.`);
      return;
    }
    const choice = await this.ask(
      `Open ${tab.title} (${mb} MB) in the editor?`,
      [
        { id: "open", label: "Open in editor", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      "The editor loads the whole file and needs several times its size in memory; it can be slow and may run out of memory. The viewer is the safe way to read very large files.",
    );
    if (choice !== "open") return;
    try {
      const content = await api.readFile(tab.path);
      const index = this.tabs.indexOf(tab);
      if (index < 0) return;
      const next = this.createText(tab.path, content, tab.id);
      const state = this.newState(content.text);
      this.runtime.set(next.id, { state, saved: state.doc, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
      this.tabs.splice(index, 1, next);
      if (tab.largeId !== null) void api.largeClose(tab.largeId);
      this.activate(next.id);
      void this.loadLanguage(next);
      if (content.lossy) this.showNotice("info", `${next.title}: some bytes are not valid ${content.encoding}.`);
    } catch (e) {
      this.showNotice("error", `Could not open ${tab.title} in the editor: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The large file view changed the document of a tab. */
  largeEdited(tab: Tab, dirty: boolean) {
    const rt = this.runtime.get(tab.id);
    if (rt) rt.version++;
    if (tab.dirty !== dirty) tab.dirty = dirty;
    this.scheduleSession();
  }

  /** Applies a large tab's hot-exit journal (forced: even though the file changed since). */
  async restoreLargeJournal(tab: Tab, force = false) {
    if (tab.largeId === null) return;
    tab.journal = "restoring";
    try {
      const result = await api.largeRestore(tab.largeId, tab.id, force);
      if (!this.tabs.includes(tab)) return;
      if (result.status === "conflict") {
        tab.journal = "conflict";
        return;
      }
      if (result.status === "missing" && tab.dirty) {
        this.showNotice("error", `The unsaved changes of ${tab.title} from the last session could not be found.`);
      }
      tab.journal = null;
      tab.dirty = result.dirty;
      tab.revision++;
      // The journal on disk is this state already.
      const rt = this.runtime.get(tab.id);
      if (rt) rt.backedUp = rt.version;
    } catch (e) {
      // Keep the journal: the user can still discard it, nothing is lost by waiting.
      if (this.tabs.includes(tab)) tab.journal = "conflict";
      this.showNotice("error", `Could not restore the unsaved changes of ${tab.title}: ${e}`);
    }
  }

  /** Drops a large tab's journal that could not be applied; the next session save deletes it. */
  discardLargeJournal(tab: Tab) {
    tab.journal = null;
    tab.dirty = false;
    this.scheduleSession();
  }

  async openPaths(paths: string[]) {
    for (const path of paths) await this.openPath(path);
  }

  async openWithDialog() {
    const dir = this.active?.path ? dirname(this.active.path) : undefined;
    const picked = await openDialog({ multiple: true, directory: false, defaultPath: dir });
    if (!picked) return;
    await this.openPaths(Array.isArray(picked) ? picked : [picked]);
  }

  private removeTab(id: string) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    if (tab.largeId !== null) void api.largeClose(tab.largeId);
    this.runtime.delete(id);
    this.compareData.delete(id);
    this.compareHandles.delete(id);
    delete this.compareChanges[id];
    if (this.activeId === id) {
      this.activeId = null;
      const next = this.tabs[index] ?? this.tabs[index - 1];
      if (next) this.activate(next.id);
    }
    if (this.tabs.length === 0) this.newUntitled();
    this.scheduleSession();
  }

  /** Closes a tab, asking to save unsaved changes. Returns false if cancelled. */
  async close(id: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return true;
    if (tab.kind === "large" && tab.journal) {
      this.activate(id);
      const choice = await this.ask(`Discard the unsaved changes to ${tab.title} from the last session?`, [
        { id: "discard", label: "Discard" },
        { id: "cancel", label: "Cancel", primary: true },
      ]);
      if (choice !== "discard") return false;
    } else if ((tab.kind === "text" || tab.kind === "large") && tab.dirty) {
      this.activate(id);
      const choice = await this.ask(`Save changes to ${tab.title}?`, [
        { id: "save", label: "Save", primary: true },
        { id: "discard", label: "Don't save" },
        { id: "cancel", label: "Cancel" },
      ]);
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.save(tab))) return false;
    }
    if (tab.path) this.closedPaths.push(tab.path);
    this.removeTab(id);
    return true;
  }

  async closeMany(ids: string[]) {
    for (const id of ids) if (!(await this.close(id))) return;
  }

  closeOthers(id: string) {
    return this.closeMany(this.tabs.filter((t) => t.id !== id).map((t) => t.id));
  }

  closeToTheRight(id: string) {
    const index = this.tabs.findIndex((t) => t.id === id);
    return this.closeMany(this.tabs.slice(index + 1).map((t) => t.id));
  }

  async reopenClosed() {
    const path = this.closedPaths.pop();
    if (path) await this.openPath(path);
  }

  cycle(delta: number) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(index + delta + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  /** Goes back (-1) or forward (+1) through the recently activated tabs, skipping closed ones. */
  navigate(delta: -1 | 1) {
    let i = this.historyIndex + delta;
    const usable = (id: string) => id !== this.activeId && this.tabs.some((t) => t.id === id);
    while (i >= 0 && i < this.history.length && !usable(this.history[i])) i += delta;
    if (i < 0 || i >= this.history.length) return;
    this.historyIndex = i;
    this.navigating = true;
    try {
      this.activate(this.history[i]);
    } finally {
      this.navigating = false;
    }
  }

  moveTab(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.scheduleSession();
  }

  // ---------------------------------------------------------------- saving

  async save(tab: Tab | undefined = this.active): Promise<boolean> {
    if (tab?.kind === "large") return this.saveLarge(tab);
    if (!tab || tab.kind !== "text") return false;
    if (!tab.path) return this.saveAs(tab);
    const state = this.stateOf(tab);
    if (!state) return false;
    const doc = state.doc;
    try {
      const mtime = await api.writeFile(tab.path, doc.toString(), tab.encoding, tab.bom, tab.eol);
      const rt = this.runtime.get(tab.id)!;
      rt.saved = doc;
      rt.metaDirty = false;
      tab.mtime = mtime;
      tab.external = null;
      tab.dirty = !this.isSaved(rt, this.stateOf(tab)!.doc);
      this.onConfigSaved(tab.path);
      this.scheduleSession();
      return true;
    } catch (e) {
      this.showNotice("error", `Could not save ${tab.title}: ${e}`);
      return false;
    }
  }

  /**
   * Saves a large tab: Rust streams the document into a temporary file that replaces the original (or
   * becomes `path`), and the tab continues on the written file.
   */
  private async saveLarge(tab: Tab, path?: string): Promise<boolean> {
    if (tab.largeId === null || !tab.path) return false;
    if (tab.journal) {
      this.showNotice("info", `First decide what happens to the unsaved changes of ${tab.title} from the last session.`);
      return false;
    }
    if (!tab.dirty && !path) return true;
    if (tab.size > 256 * 1024 * 1024) this.showNotice("info", `Saving ${tab.title}…`);
    try {
      const opened = await api.largeSave(tab.largeId, path ?? null, tab.id);
      if (!this.tabs.includes(tab)) return true;
      Object.assign(tab, {
        largeId: opened.id,
        path: path ?? tab.path,
        title: basename(path ?? tab.path),
        mtime: opened.mtime,
        size: opened.size,
        dirty: false,
        external: null,
      });
      const rt = this.runtime.get(tab.id);
      if (rt) rt.diskIgnored = undefined;
      if (this.notice?.text.startsWith("Saving ")) this.notice = null;
      this.scheduleSession();
      return true;
    } catch (e) {
      this.showNotice("error", `Could not save ${tab.title}: ${e}`);
      return false;
    }
  }

  async saveAs(tab: Tab | undefined = this.active): Promise<boolean> {
    if (!tab || (tab.kind !== "text" && tab.kind !== "large")) return false;
    const defaultPath = tab.path ?? `${tab.title}.txt`;
    const path = await saveDialog({ defaultPath });
    if (!path) return false;
    const other = this.tabs.find((t) => t.id !== tab.id && t.path && samePath(t.path, path));
    if (tab.kind === "large") {
      if (tab.path && samePath(tab.path, path)) return this.saveLarge(tab);
      const saved = await this.saveLarge(tab, path);
      if (saved && other) this.removeTab(other.id);
      return saved;
    }
    if (other) this.removeTab(other.id);
    tab.path = path;
    tab.title = basename(path);
    const detected = detectLanguage(path, this.textOf(tab).slice(0, 300).split("\n")[0])?.name ?? null;
    if (detected && detected !== tab.language) this.setLanguage(tab, detected);
    return this.save(tab);
  }

  async saveAll() {
    for (const tab of this.tabs.filter((t) => (t.kind === "text" || t.kind === "large") && t.dirty && !t.journal)) {
      if (!tab.path) this.activate(tab.id);
      if (!(await this.save(tab))) return;
    }
  }

  // ---------------------------------------------------------------- reload, encodings, line endings

  /** Reloads a file from disk; as an undoable edit, keeping the cursor where possible. */
  async reload(tab: Tab | undefined = this.active, encoding?: string) {
    if (!tab?.path) return;
    if (tab.kind === "large") {
      await this.reopenLarge(tab);
      return;
    }
    if (tab.kind === "image") {
      const stat = await api.statFile(tab.path);
      tab.mtime = stat.mtime;
      tab.size = stat.size;
      tab.external = null;
      return;
    }
    try {
      const content = await api.readFile(tab.path, encoding);
      const state = this.stateOf(tab)!;
      const change = minimalChange(state.doc.toString(), content.text);
      const rt = this.runtime.get(tab.id)!;
      if (tab.id === this.activeId && this.view) this.view.dispatch({ changes: change });
      else rt.state = state.update({ changes: change }).state;
      rt.saved = this.stateOf(tab)!.doc;
      rt.metaDirty = false;
      Object.assign(tab, {
        encoding: content.encoding,
        bom: content.bom,
        eol: content.eol,
        mtime: content.mtime,
        size: content.size,
        binary: content.binary,
        lossy: content.lossy,
        dirty: false,
        external: null,
      });
      this.renderPreview();
    } catch (e) {
      this.showNotice("error", `Could not reload ${tab.title}: ${e}`);
    }
  }

  async reopenWithEncoding(tab: Tab, encoding: string) {
    if (tab.dirty) {
      const choice = await this.ask(`Reopening ${tab.title} discards your unsaved changes.`, [
        { id: "reopen", label: "Reopen", primary: true },
        { id: "cancel", label: "Cancel" },
      ]);
      if (choice !== "reopen") return;
    }
    await this.reload(tab, encoding === "UTF-8 BOM" ? "UTF-8" : encoding);
  }

  /** Changes the encoding the file is saved with. */
  convertEncoding(tab: Tab, encoding: string) {
    tab.bom = encoding === "UTF-8 BOM" || encoding.startsWith("UTF-16");
    tab.encoding = encoding === "UTF-8 BOM" ? "UTF-8" : encoding;
    this.markMetaDirty(tab);
  }

  setEol(tab: Tab, eol: Eol) {
    if (tab.eol === eol) return;
    tab.eol = eol;
    this.markMetaDirty(tab);
  }

  private markMetaDirty(tab: Tab) {
    const rt = this.runtime.get(tab.id);
    if (!rt || tab.kind !== "text") return;
    rt.metaDirty = true;
    tab.dirty = true;
    this.scheduleSession();
  }

  /** Detects files changed or deleted by other programs. */
  async checkExternalChanges(only?: Tab) {
    const tabs = (only ? [only] : this.tabs).filter((t) => t.path);
    if (!tabs.length) return;
    const stats = await api.statFiles(tabs.map((t) => t.path!));
    tabs.forEach((tab, i) => {
      const stat = stats[i];
      if (!this.tabs.includes(tab)) return;
      if (tab.kind === "large" && (tab.dirty || tab.journal)) {
        // Unsaved edits refer to the file as it was: never follow or reopen it, only warn (once per
        // state of the file, so "Keep my version" sticks).
        const rt = this.runtime.get(tab.id);
        const seen = stat.exists ? `${stat.mtime}:${stat.size}` : "deleted";
        if (rt) rt.diskSeen = seen;
        const changed = !stat.exists || stat.mtime !== tab.mtime || stat.size !== tab.size;
        if (changed && seen !== rt?.diskIgnored && tab.external === null) tab.external = stat.exists ? "modified" : "deleted";
        return;
      }
      if (!stat.exists) {
        if (tab.external !== "deleted") {
          tab.external = "deleted";
          if (tab.kind === "text") this.markMetaDirty(tab);
        }
      } else if (tab.kind === "large") {
        if (stat.mtime !== tab.mtime || stat.size !== tab.size) void this.refreshLarge(tab, stat);
        else if (tab.external === "deleted") tab.external = null;
      } else if (stat.mtime !== tab.mtime) {
        if (tab.kind === "text" && !tab.dirty) void this.reload(tab, tab.encoding);
        else if (tab.kind === "image") void this.reload(tab);
        else if (tab.external === null) tab.external = "modified";
      } else if (tab.external === "deleted") {
        tab.external = null;
      }
    });
  }

  keepMine(tab: Tab) {
    tab.external = null;
    if (tab.kind === "text") this.markMetaDirty(tab);
    if (tab.kind === "large") {
      const rt = this.runtime.get(tab.id);
      if (rt) rt.diskIgnored = rt.diskSeen;
    }
  }

  // ---------------------------------------------------------------- compare

  compareOf(id: string) {
    return this.compareData.get(id);
  }

  registerCompare(id: string, handle: CompareHandleLike | null) {
    if (handle) this.compareHandles.set(id, handle);
    else this.compareHandles.delete(id);
  }

  /** Jumps to the next (1) or previous (-1) change of the active compare tab. */
  compareStep(delta: 1 | -1) {
    const handle = this.activeId ? this.compareHandles.get(this.activeId) : undefined;
    if (delta > 0) handle?.next();
    else handle?.previous();
  }

  // ---------------------------------------------------------------- settings page

  /** Shows the settings page: one tab for all, next to the tab it was started from. */
  showSettings() {
    const open = this.tabs.find((t) => t.kind === "settings");
    if (open) return this.activate(open.id);
    const tab = this.textTab({ kind: "settings", title: "Settings" });
    const index = this.tabs.findIndex((t) => t.id === this.activeId);
    this.tabs.splice(index + 1, 0, tab);
    this.activate(tab.id);
  }

  /** Escape on the settings page: back to the tab it was opened from (the page stays open as a tab). */
  leaveSettings() {
    const id = this.activeId;
    this.navigate(-1);
    if (this.activeId === id) this.cycle(1);
  }

  private openCompare(left: CompareSide, right: CompareSide, language: string | null) {
    const tab = this.textTab({ kind: "compare", title: `${left.label} ↔ ${right.label}`, language });
    this.compareData.set(tab.id, { left, right });
    // Right next to the tab it was started from.
    const index = this.tabs.findIndex((t) => t.id === this.activeId);
    this.tabs.splice(index + 1, 0, tab);
    this.activate(tab.id);
  }

  /** Same file name in two folders: the folder name tells them apart. */
  private compareLabel(tab: Tab, other: Tab): string {
    if (tab.title !== other.title || !tab.path || !other.path) return tab.title;
    return `${tab.title} (${basename(dirname(tab.path))})`;
  }

  /** Compares the file on disk (left) with the text in the editor (right). */
  async compareWithDisk(tab: Tab | undefined = this.active) {
    if (!tab || tab.kind !== "text" || !tab.path) return;
    try {
      const disk = await api.readFile(tab.path, tab.encoding);
      this.openCompare(
        { label: `${tab.title} (on disk)`, text: disk.text },
        { label: tab.title, text: this.textOf(tab) },
        tab.language,
      );
    } catch (e) {
      this.showNotice("error", `Could not read ${tab.title} from disk: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Asks what to compare the active tab with: another open tab, its file on disk or the clipboard. */
  async compareWith() {
    const tab = this.active;
    if (!tab || tab.kind !== "text") return;
    const items: PickItem[] = this.tabs
      .filter((t) => t.kind === "text" && t.id !== tab.id)
      .map((t) => ({ id: t.id, label: t.title, detail: t.path ?? "" }));
    if (tab.path) items.unshift({ id: "@disk", label: "File on disk", detail: tab.path });
    items.push({ id: "@clipboard", label: "Clipboard" });
    const picked = await this.pick({ placeholder: `Compare ${tab.title} with…`, items });
    if (!picked || typeof picked === "string") return;
    if (picked.id === "@disk") return this.compareWithDisk(tab);
    if (picked.id === "@clipboard") {
      try {
        const text = (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n");
        this.openCompare({ label: tab.title, text: this.textOf(tab) }, { label: "Clipboard", text }, tab.language);
      } catch (e) {
        this.showNotice("error", `Could not read the clipboard: ${e instanceof Error ? e.message : e}`);
      }
      return;
    }
    const other = this.tabs.find((t) => t.id === picked.id);
    if (!other) return;
    this.openCompare(
      { label: this.compareLabel(tab, other), text: this.textOf(tab) },
      { label: this.compareLabel(other, tab), text: this.textOf(other) },
      tab.language ?? other.language,
    );
  }

  // ---------------------------------------------------------------- navigation & view

  async gotoLine() {
    const tab = this.active;
    if (!tab || tab.kind === "image" || tab.kind === "compare" || tab.kind === "settings") return;
    const max = tab.kind === "large" ? this.largeStatus.lines : this.cursor.lines;
    const answer = await this.pick({ placeholder: `Go to line (1 – ${max})`, items: [], freeText: true });
    const line = typeof answer === "string" ? parseInt(answer, 10) : NaN;
    if (!Number.isFinite(line)) return;
    if (tab.kind === "large") {
      this.largeApi?.gotoLine(line);
      return;
    }
    const view = this.view!;
    const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({
      selection: EditorSelection.cursor(target.from),
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    view.focus();
  }

  toggleWrap() {
    this.ui.wordWrap = !this.ui.wordWrap;
    this.applyViewOptions();
    this.scheduleSession();
  }

  toggleSpellCheck() {
    this.ui.spellCheck = !this.ui.spellCheck;
    this.applyViewOptions();
    this.showNotice("info", `Spell checking ${this.ui.spellCheck ? "on" : "off"}.`);
    this.scheduleSession();
  }

  /**
   * The settings page changed wordWrap, spellCheck or grammarCheck: the settings are the start-up values and the session
   * keeps the current ones, so the current state follows at once. Turning grammar checking on may offer to download LanguageTool.
   */
  followSetting(name: "wordWrap" | "spellCheck" | "grammarCheck") {
    const want = settings[name];
    if (this.ui[name] === want) return;
    if (name === "wordWrap") this.toggleWrap();
    else if (name === "spellCheck") this.toggleSpellCheck();
    else void this.toggleGrammarCheck();
  }

  /** Pretty-prints (or minifies) the JSON in the active tab. */
  formatJson(minify = false) {
    return this.format(minify ? "minify" : "json");
  }

  /**
   * Formats the selected lines, or the whole document, as one undoable edit. "auto" picks the formatter
   * from the tab's language; "json" and "minify" are the JSON commands, whatever the language.
   */
  async format(mode: "auto" | "json" | "minify" = "auto") {
    const tab = this.active;
    const view = this.view;
    if (!tab || tab.kind !== "text" || !view) return;
    const formatter: Formatter | null = mode === "auto" ? formatterFor(tab.language) : { kind: "json" };
    if (!formatter) {
      this.showNotice(
        "info",
        `No formatter for ${tab.language ?? "plain text"}. Formatting works for ${formattableLanguages().join(", ")}.`,
      );
      return;
    }

    const before = view.state;
    const doc = before.doc;
    const sel = before.selection.main;
    let from = 0;
    let to = doc.length;
    if (!sel.empty) {
      // Whole lines; a selection that ends at the start of a line does not include that line.
      const last = doc.lineAt(sel.to);
      from = doc.lineAt(sel.from).from;
      to = sel.to === last.from && last.number > doc.lineAt(sel.from).number ? doc.line(last.number - 1).to : last.to;
    }
    const partial = !sel.empty;
    const text = doc.sliceString(from, to);
    if (text.trim() === "") {
      this.showNotice("info", "Nothing to format.");
      return;
    }

    // A selection is formatted without its own indentation, which is put back afterwards.
    const base = partial ? (/^[ \t]*/.exec(text)?.[0] ?? "") : "";
    const input = base
      ? text.split("\n").map((l) => (l.startsWith(base) ? l.slice(base.length) : l)).join("\n")
      : text;
    const label = mode === "auto" ? tab.language : "JSON";
    const what = partial ? `the selection as ${label}` : label;
    const options = { tabSize: settings.tabSize, insertSpaces: settings.insertSpaces };
    let result;
    try {
      result =
        mode === "minify" ? minifyJson(input) : await formatWith(formatter, input, options, doc.lineAt(from).number);
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    if ("error" in result) {
      this.showNotice("error", `Cannot format ${what}: ${result.error}`);
      return;
    }
    if (view !== this.view || view.state.doc !== doc || this.active?.id !== tab.id) {
      this.showNotice("info", "The text changed while formatting, so nothing was applied. Run it again.");
      return;
    }

    let formatted = result.text.replace(/\n+$/, "");
    if (base) formatted = formatted.split("\n").map((l) => (l ? base + l : l)).join("\n");
    // Prettier always ends with a newline; the others keep what the document had.
    const newline = formatter.kind === "prettier" || text.endsWith("\n");
    if (!partial && mode !== "minify" && formatted && newline) formatted += "\n";
    if (formatted === text) {
      this.showNotice("info", "Already formatted.");
      return;
    }
    const change = minimalChange(text, formatted);
    const selection = partial
      ? EditorSelection.single(from, from + formatted.length)
      : EditorSelection.cursor(from + mapCursor(text, formatted, sel.head - from));
    view.dispatch({
      changes: { from: from + change.from, to: from + change.to, insert: change.insert },
      selection,
      scrollIntoView: true,
    });
  }

  zoom(delta: number | null) {
    this.ui.zoom = delta === null ? 0 : Math.max(-8, Math.min(30, this.ui.zoom + delta));
    this.scheduleSession();
  }

  previewAvailable(tab: Tab | undefined): boolean {
    return !!tab && tab.kind === "text" && (isMarkdown(tab.language) || (!!tab.path && extensionOf(tab.path) === "svg"));
  }

  togglePreview() {
    const tab = this.active;
    if (!tab || !this.previewAvailable(tab)) {
      this.showNotice("info", "The preview is available for Markdown and SVG files.");
      return;
    }
    tab.preview = tab.preview === "off" ? "split" : tab.preview === "split" ? "only" : "off";
    this.renderPreview();
    if (tab.preview !== "only") requestAnimationFrame(() => !this.picker && !this.dialog && this.view?.focus());
    this.scheduleSession();
  }

  // ---------------------------------------------------------------- preview

  private schedulePreview() {
    clearTimeout(this.previewTimer);
    const delay = (this.view?.state.doc.length ?? 0) > 200_000 ? 400 : 120;
    this.previewTimer = window.setTimeout(() => this.renderPreview(), delay);
  }

  renderPreview() {
    const tab = this.active;
    if (!tab || tab.preview === "off" || !this.previewAvailable(tab)) {
      this.previewHtml = "";
      return;
    }
    const text = this.textOf(tab);
    this.previewHtml = isMarkdown(tab.language)
      ? renderMarkdown(text, tab.path ? dirname(tab.path) : null)
      : renderSvg(text);
  }

  /** Called by the preview pane so it can follow the editor's scroll position. */
  onEditorScroll: () => void = () => {};

  /** The first visible line in the editor (1-based) and how far it is scrolled past. */
  topVisibleLine(): { line: number; fraction: number } {
    const view = this.view;
    if (!view) return { line: 1, fraction: 0 };
    const top = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(top);
    return {
      line: view.state.doc.lineAt(block.from).number,
      fraction: block.height ? (top - block.top) / block.height : 0,
    };
  }

  /** Pasting an image into a Markdown file saves it next to the file and inserts a link. */
  private onPaste(event: ClipboardEvent): boolean {
    const tab = this.active;
    if (!tab || !isMarkdown(tab.language)) return false;
    const item = [...(event.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return false;
    event.preventDefault();
    if (!tab.path) {
      this.showNotice("info", "Save the Markdown file first, so pasted images have a folder to go to.");
      return true;
    }
    const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png";
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const folder = settings.pasteImageFolder.replace(/^[\\/]+|[\\/]+$/g, "");
    const name = `image-${stamp}.${ext}`;
    const relative = folder ? `${folder}/${name}` : name;
    const target = resolvePath(dirname(tab.path), relative);
    const view = this.view!;
    void blobToBase64(file)
      .then((data) => api.writeBinary(target, data))
      .then(() => {
        view.dispatch(view.state.replaceSelection(`![](${encodeURI(relative)})`));
        this.renderPreview();
      })
      .catch((e) => this.showNotice("error", `Could not save the pasted image: ${e}`));
    return true;
  }

  // ---------------------------------------------------------------- dialogs

  showNotice(kind: "info" | "error", text: string) {
    if (kind === "error") void invoke("frontend_log", { message: text });
    this.notice = { kind, text };
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => (this.notice = null), kind === "error" ? 10_000 : 5_000);
  }

  ask(message: string, buttons: DialogRequest["buttons"], detail?: string): Promise<string> {
    return new Promise((resolve) => {
      this.dialog = {
        message,
        detail,
        buttons,
        resolve: (id) => {
          this.dialog = null;
          resolve(id);
        },
      };
    });
  }

  pick(request: Omit<PickerRequest, "resolve">): Promise<PickItem | string | null> {
    this.picker?.resolve(null);
    return new Promise((resolve) => {
      this.picker = {
        ...request,
        resolve: (value) => {
          this.picker = null;
          resolve(value);
          // Not when the answer opened the next picker (command palette -> "Compare with…"), which wants the focus.
          if (this.active?.kind === "text") requestAnimationFrame(() => !this.picker && !this.dialog && this.view?.focus());
        },
      };
    });
  }

  // ---------------------------------------------------------------- session (hot exit)

  /**
   * Throttle, not debounce: the first change arms a timer and later changes leave it alone, so
   * continuous typing is backed up every few hundred ms instead of never. The whole text of a tab is
   * written each time, so large documents wait longer (at most 3 s).
   */
  scheduleSession() {
    if (!this.restored || this.sessionTimer) return;
    const size = this.view?.state.doc.length ?? 0;
    const delay = Math.min(3000, 300 + size / 500);
    this.sessionTimer = window.setTimeout(() => void this.saveSession(), delay);
  }

  /** Persists open tabs and backs up unsaved text, so closing never loses anything. */
  saveSession(): Promise<void> {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = 0;
    this.sessionChain = this.sessionChain.then(() => this.writeSession()).catch((e) => console.error(e));
    return this.sessionChain;
  }

  private async writeSession() {
    if (this.active?.kind === "text" && this.view) {
      const rt = this.runtime.get(this.active.id);
      if (rt) {
        rt.state = this.view.state;
        rt.scrollTop = this.view.scrollDOM.scrollTop;
      }
    }
    const keep: string[] = [];
    const tabs: SessionTab[] = [];
    // Snapshot of state and version together: edits during the awaits below must not be marked as
    // backed up when an older text was written. Compare tabs are snapshots and the settings tab
    // is only a view: nothing to restore.
    const snapshot = this.tabs.filter((tab) => tab.kind !== "compare" && tab.kind !== "settings").map((tab) => {
      const rt = this.runtime.get(tab.id);
      return { tab, rt, state: rt?.state, version: rt?.version ?? 0 };
    });
    for (const { tab, rt, state, version } of snapshot) {
      // Large tabs back up a journal of their edits (large.rs); one that is still being restored or
      // waits for a decision is kept as it is.
      const largeBackup = tab.kind === "large" && (tab.dirty || tab.journal !== null);
      const needsBackup = largeBackup || (tab.kind === "text" && !!state && (tab.dirty || (!tab.path && state.doc.length > 0)));
      if (needsBackup && rt) {
        keep.push(tab.id);
        if (rt.backedUp !== version) {
          if (!largeBackup) {
            await api.backupWrite(tab.id, state!.doc.toString());
            rt.backedUp = version;
          } else if (tab.largeId !== null && !tab.journal) {
            // A journal that cannot be written (disk full, …) must not stop the session from being saved;
            // it is tried again with the next change, and the user is told.
            try {
              await api.largeBackup(tab.largeId, tab.id);
              rt.backedUp = version;
            } catch (e) {
              this.showNotice("error", `Could not back up the unsaved changes of ${tab.title}: ${e}`);
            }
          }
        }
      }
      if (!tab.path && !needsBackup) continue;
      tabs.push({
        id: tab.id,
        kind: tab.kind,
        path: tab.path,
        title: tab.title,
        encoding: tab.encoding,
        bom: tab.bom,
        eol: tab.eol,
        language: tab.language,
        preview: tab.preview,
        grammarLanguage: this.grammarLanguages.get(tab.id),
        hasBackup: needsBackup,
        cursor: state?.selection.main.head ?? 0,
        scrollTop: rt?.scrollTop ?? 0,
      });
    }
    const session: Session = {
      version: 1,
      activeId: this.activeId,
      wordWrap: this.ui.wordWrap,
      spellCheck: this.ui.spellCheck,
      grammarCheck: this.ui.grammarCheck,
      zoom: this.ui.zoom,
      tabs,
    };
    await api.sessionSave(JSON.stringify(session));
    await api.backupPrune(keep);
  }

  /** Offers the older backup versions of the active tab and opens the chosen one in a new tab. */
  async restoreBackupVersion() {
    const tab = this.active;
    if (!tab || tab.kind !== "text") return;
    const versions = await api.backupVersions(tab.id);
    if (versions.length === 0) {
      this.showNotice("info", "There are no older backups of this tab yet. Versions are kept while a tab has unsaved changes.");
      return;
    }
    const items = versions.map((v) => ({ id: String(v.n), label: ago(v.mtime), detail: formatBytes(v.size) }));
    const picked = await this.pick({ placeholder: "Restore an older backup (opens in a new tab)", items });
    if (!picked || typeof picked === "string") return;
    const text = await api.backupReadVersion(tab.id, Number(picked.id));
    if (text === null) {
      this.showNotice("error", "That backup is gone.");
      return;
    }
    // Never overwrite the current tab: the old text opens next to it.
    const restored = this.textTab({
      title: this.untitledTitle(),
      encoding: tab.encoding,
      bom: tab.bom,
      eol: tab.eol,
      language: tab.language,
      dirty: text.length > 0,
    });
    const state = this.newState(text);
    this.addTab(restored, { state, saved: Text.empty, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
    void this.loadLanguage(restored);
  }

  async restoreSession() {
    this.ui.wordWrap = settings.wordWrap;
    this.ui.spellCheck = settings.spellCheck;
    this.ui.grammarCheck = settings.grammarCheck;
    let session: Session | null = null;
    try {
      const json = await api.sessionLoad();
      session = json ? (JSON.parse(json) as Session) : null;
    } catch (e) {
      console.error("Ignoring unreadable session", e);
    }
    if (session) {
      this.ui.wordWrap = session.wordWrap;
      this.ui.spellCheck = session.spellCheck ?? settings.spellCheck;
      this.ui.grammarCheck = session.grammarCheck ?? settings.grammarCheck;
      this.ui.zoom = session.zoom ?? 0;
      for (const saved of session.tabs) {
        try {
          await this.restoreTab(saved);
        } catch (e) {
          console.error("Could not restore tab", saved, e);
        }
      }
      const active = this.tabs.find((t) => t.id === session.activeId) ?? this.tabs[this.tabs.length - 1];
      if (active) this.activate(active.id);
    }
    if (this.tabs.length === 0) this.newUntitled();
    this.restored = true;
  }

  private async restoreTab(saved: SessionTab) {
    if (saved.kind === "compare" || saved.kind === "settings") return;
    if (saved.kind === "large" && saved.path) {
      if (!(await api.statFile(saved.path)).exists) return;
      await this.openLarge(saved.path, saved.id);
      const tab = this.tabs.find((t) => t.id === saved.id);
      if (tab) {
        // Applied in the background: it waits for the line index, which takes a while for huge files.
        // Asked for every large tab, not only those marked `hasBackup`: a crash right after the journal
        // was written can leave an older session file, and a journal must never be pruned unseen.
        tab.dirty = saved.hasBackup;
        tab.journal = "restoring";
        void this.restoreLargeJournal(tab);
      }
      return;
    }
    if (saved.kind === "image" && saved.path) {
      const stat = await api.statFile(saved.path);
      if (stat.exists) {
        this.tabs.push(this.textTab({ ...saved, kind: "image", mtime: stat.mtime, size: stat.size }));
        this.runtime.set(saved.id, { state: null, saved: Text.empty, metaDirty: false, scrollTop: 0, version: 0, backedUp: -1 });
      }
      return;
    }

    const backup = saved.hasBackup ? await api.backupRead(saved.id) : null;
    let disk: FileContent | null = null;
    if (saved.path && (await api.statFile(saved.path)).exists) {
      disk = await api.readFile(saved.path, saved.hasBackup ? saved.encoding : undefined);
    }
    const text = backup ?? disk?.text;
    if (text === undefined) return;

    const tab = disk ? this.createText(saved.path!, disk, saved.id) : this.textTab({ id: saved.id, title: saved.title });
    if (saved.path && !disk) tab.path = saved.path;
    tab.language = saved.language;
    tab.preview = saved.preview;
    if (saved.grammarLanguage) this.grammarLanguages.set(tab.id, saved.grammarLanguage);
    if (backup !== null) Object.assign(tab, { encoding: saved.encoding, bom: saved.bom, eol: saved.eol });

    let state = this.newState(text);
    const cursor = Math.min(saved.cursor, state.doc.length);
    state = state.update({ selection: EditorSelection.cursor(cursor) }).state;
    const savedDoc = disk ? Text.of(disk.text.split("\n")) : Text.empty;
    const rt: Runtime = { state, saved: savedDoc, metaDirty: false, scrollTop: saved.scrollTop, version: 0, backedUp: -1 };
    if (backup !== null) {
      rt.metaDirty = !!disk && (disk.encoding !== saved.encoding || disk.bom !== saved.bom || disk.eol !== saved.eol);
      tab.dirty = rt.metaDirty || !this.isSaved(rt, state.doc);
      // Already on disk as a backup; only rewrite it after the next edit.
      rt.backedUp = rt.version;
    }
    if (saved.path && !disk) {
      tab.external = "deleted";
      tab.dirty = true;
      rt.metaDirty = true;
    }
    this.runtime.set(tab.id, rt);
    this.tabs.push(tab);
    void this.loadLanguage(tab);
  }
}

export const workspace = new Workspace();
