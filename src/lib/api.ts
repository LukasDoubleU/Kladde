// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";

export type Eol = "CRLF" | "LF" | "CR";

export interface FileContent {
  text: string;
  encoding: string;
  bom: boolean;
  eol: Eol;
  mtime: number;
  size: number;
  binary: boolean;
  lossy: boolean;
}

export interface FileStat {
  exists: boolean;
  isFile: boolean;
  mtime: number;
  size: number;
}

export interface LargeOpened {
  id: number;
  size: number;
  encoding: string;
  mtime: number;
}

export interface LargeLine {
  text: string;
  truncated: boolean;
}

export interface LargeMatch {
  line: number;
  col: number;
  len: number;
}

export const api = {
  initialPaths: () => invoke<string[]>("initial_paths"),
  readFile: (path: string, encoding?: string) => invoke<FileContent>("read_file", { path, encoding }),
  writeFile: (path: string, text: string, encoding: string, bom: boolean, eol: Eol) =>
    invoke<number>("write_file", { path, text, encoding, bom, eol }),
  writeBinary: (path: string, base64: string) => invoke<void>("write_binary", { path, base64 }),
  statFile: (path: string) => invoke<FileStat>("stat_file", { path }),
  statFiles: (paths: string[]) => invoke<FileStat[]>("stat_files", { paths }),

  largeOpen: (path: string) => invoke<LargeOpened>("large_open", { path }),
  largeInfo: (id: number) => invoke<{ lines: number; done: boolean }>("large_info", { id }),
  largeLines: (id: number, start: number, count: number) =>
    invoke<LargeLine[]>("large_lines", { id, start, count }),
  largeSearch: (
    id: number,
    query: string,
    from: { line: number; col: number },
    forward: boolean,
    inclusive: boolean,
    matchCase: boolean,
  ) => invoke<LargeMatch | null>("large_search", { id, query, ...from, forward, inclusive, matchCase }),
  largeClose: (id: number) => invoke<void>("large_close", { id }),

  sessionLoad: () => invoke<string | null>("session_load"),
  sessionSave: (json: string) => invoke<void>("session_save", { json }),
  backupWrite: (id: string, text: string) => invoke<void>("backup_write", { id, text }),
  backupRead: (id: string) => invoke<string | null>("backup_read", { id }),
  backupPrune: (keep: string[]) => invoke<void>("backup_prune", { keep }),

  configRead: (name: string) => invoke<string | null>("config_read", { name }),
  configFile: (name: string, defaultContent: string) =>
    invoke<string>("config_file", { name, default: defaultContent }),
  configDir: () => invoke<string>("config_dir"),
};
