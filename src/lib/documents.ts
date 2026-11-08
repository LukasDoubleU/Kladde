// The read-only document viewer (tab kind "document"): which files it takes, how a file that cannot be shown is
// told apart, and the texts of the errors. Plain TypeScript without imports, so unit tests can load it.

/** File types shown in a document tab. A later PDF viewer adds its extension here and its engine to the viewer. */
export const DOCUMENT_EXTENSIONS = new Set(["docx"]);

/** The size above which a document is not read (the same limit as `MAX_DOCUMENT_BYTES` in files.rs). */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

function extension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extension(path));
}

/** What the status bar calls the format of a document. */
export function documentFormat(path: string | null): string {
  return path && extension(path) === "docx" ? "Word document" : "Document";
}

/** The first bytes of a file say what container it is, whatever its extension claims. */
export type Container = "zip" | "compound" | "unknown";

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04], // a local file header
  [0x50, 0x4b, 0x05, 0x06], // an empty archive
];
// OLE compound file (D0 CF 11 E0 ...): what Word makes of a password-protected or rights-managed .docx (the package
// is encrypted into a stream of this container), and also the old binary .doc format. Four bytes are enough.
const COMPOUND_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0];

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

export function containerOf(bytes: Uint8Array): Container {
  if (ZIP_SIGNATURES.some((s) => startsWith(bytes, s))) return "zip";
  if (startsWith(bytes, COMPOUND_SIGNATURE)) return "compound";
  return "unknown";
}

/** An error shown in the tab instead of the document. */
export interface DocumentProblem {
  kind: "encrypted" | "notDocument" | "corrupt" | "tooLarge" | "unreadable";
  message: string;
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function problemFor(container: Container): DocumentProblem | null {
  if (container === "compound") {
    return {
      kind: "encrypted",
      message:
        "This file is encrypted or protected by rights management (or it is an old .doc file), so Kladde cannot show it.",
    };
  }
  if (container === "unknown") {
    return {
      kind: "notDocument",
      message: "This is not a Word document: a .docx file is a ZIP package, and this file is not one.",
    };
  }
  return null;
}

export function corruptProblem(detail: string): DocumentProblem {
  return {
    kind: "corrupt",
    message: `The Word document could not be read. It may be damaged. (${detail || "unknown error"})`,
  };
}

export function tooLargeProblem(size: number): DocumentProblem {
  const shown = size > 0 ? `This document is ${formatMegabytes(size)}. ` : "";
  return {
    kind: "tooLarge",
    message: `${shown}Kladde shows documents up to ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
  };
}

/**
 * The page count a program wrote into the document (`docProps/app.xml`, `Pages`), or null when there is none. What
 * the viewer renders is not that: it breaks pages only where the file says so (explicit breaks and sections), so a
 * long text without them is one tall box. The file's own number is shown, or none.
 */
export function pageCountOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : null;
}

/**
 * The scale factor of a document for Kladde's zoom (points added to the font size): the zoom keys and
 * Ctrl+wheel change the font size, and a document grows by the same proportion.
 */
export function zoomFactor(zoom: number, fontSize: number): number {
  const base = Math.max(6, fontSize);
  return Math.max(6, base + zoom) / base;
}

/** The scale that makes pages of `natural` px fit into `available` px, never enlarging them. */
export function fitScale(available: number, natural: number): number {
  if (!(natural > 0) || !(available > 0)) return 1;
  return Math.min(1, available / natural);
}

// ---------------------------------------------------------------------------------------------------------------
// The frame a document is shown in. A document is untrusted, so it never shares Kladde's page: it is rendered into
// a `srcdoc` iframe whose document carries a CSP of its own. The page's CSP allows https images (the Markdown
// preview shows remote ones); this one allows nothing but `data:` images and fonts. A srcdoc frame also inherits
// the page's policy, so both apply and the stricter wins for every request.

/**
 * The frame's policy. Everything is denied by default (scripts, frames, objects, media, `<link>`, fetch and the
 * ping of a link all fall under `default-src`), images and fonts may be `data:` (the engine inlines both), and
 * styles may be inline (the engine builds `<style>` elements and `style` attributes). `base-uri` and `form-action`
 * do not fall back to `default-src`, so they are named.
 */
export const FRAME_CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * What the frame may do besides showing the document: only keep the page's origin, which the page needs to drive
 * it (listeners on its window and document, its selection, its scroll position). No scripts (the CSP says so too),
 * no top navigation, no forms, no popups, no downloads, no pointer lock. Frame navigation is not covered by
 * sandbox flags; the Rust navigation guard cancels it (`FrameNavigationStarting`).
 */
export const FRAME_SANDBOX = "allow-same-origin";

/** The app's theme variables the frame needs: they do not inherit into an iframe, so the page copies their values. */
export const FRAME_VARIABLES = ["--bg-alt", "--fg-dim", "--paper", "--paper-text", "--paper-insert", "--paper-delete"] as const;

/** The element of the frame's document that holds the rendered document (and is zoomed). */
export const FRAME_HOST_ID = "host";

// The frame's own chrome: the desk, the scrollbars of the app, and the host that is zoomed and centered. Before the
// document's styles (which cannot reach these: they style `.docx` classes) and without the paper overrides, which
// have to come after them.
const FRAME_CSS = `
html { background: var(--bg-alt); overflow-anchor: none; }
body { margin: 0; }
::-webkit-scrollbar { width: 12px; height: 12px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg-dim) 45%, transparent); border: 3px solid transparent; background-clip: content-box; border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background-color: var(--fg-dim); }
::-webkit-scrollbar-corner { background: transparent; }
.stage { display: flex; justify-content: center; width: max-content; min-width: 100%; }
#${FRAME_HOST_ID} {
  width: max-content;
  /* What a document without fonts of its own gets, not the UI font. */
  font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif;
  font-size: 11pt;
  line-height: normal;
  color: var(--paper-text);
  text-align: left;
  cursor: auto;
  user-select: text;
}`;

/** The document the frame starts with: the policy first, before anything that could load something, then an empty host. */
export function frameSrcdoc(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_CSS}</style></head><body><div class="stage"><div id="${FRAME_HOST_ID}"></div></div></body></html>`;
}

/** The part of a keyboard event the page's shortcut handling reads, for a copy it can dispatch on its own element. */
export function keyboardInit(e: KeyboardEvent): KeyboardEventInit {
  return {
    key: e.key,
    code: e.code,
    location: e.location,
    repeat: e.repeat,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    // AltGr reports Ctrl+Alt and types a character: `comboFromEvent` asks for it.
    modifierAltGraph: e.getModifierState?.("AltGraph") ?? false,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/** A wheel event of the frame as the same event at the same place of the page (`frame`: the iframe's box). */
export function wheelInit(e: WheelEvent, frame: { left: number; top: number }): WheelEventInit {
  return {
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX + frame.left,
    clientY: e.clientY + frame.top,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/** A mouse event of the frame as the same event at the same place of the page. */
export function mouseInit(e: MouseEvent, frame: { left: number; top: number }): MouseEventInit {
  return {
    button: e.button,
    buttons: e.buttons,
    clientX: e.clientX + frame.left,
    clientY: e.clientY + frame.top,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/** Ctrl+A (no other modifier): in the viewer it selects the document, not everything the frame has. */
export function isSelectAll(e: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a";
}
