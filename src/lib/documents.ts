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
