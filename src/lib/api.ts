// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke } from "@tauri-apps/api/core";

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

export interface BackupVersion {
  /** 1 is the newest older version. */
  n: number;
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

export interface LargeInfo {
  lines: number;
  done: boolean;
  size: number;
}

export interface LargeSearchResult {
  found: LargeMatch | null;
  /** A newer search or a cancel request stopped it. */
  cancelled: boolean;
}

export interface LargeRefresh {
  size: number;
  mtime: number;
  /** Not just appended to: the file has to be reopened. */
  changed: boolean;
}

export interface IntegrationGroup {
  id: string;
  label: string;
  extensions: string[];
}

export interface IntegrationStatus {
  /** Anything of Kladde is registered with Windows (file types or the context menu entry). */
  present: boolean;
  /** Registered for this exe and the current extension list; false means it needs a refresh. */
  current: boolean;
  /** Ids of the registered file type groups. */
  groups: string[];
  contextMenu: boolean;
  /** Show the start-up offer: nothing registered yet and not dismissed. */
  offer: boolean;
  available: IntegrationGroup[];
}

export interface UpdateInfo {
  version: string;
  /** Release notes from the update manifest, if it has any. */
  notes: string | null;
  /** A portable exe cannot be updated in place: it is offered the download page instead. */
  portable: boolean;
}

export type UpdateProgress =
  | { event: "downloading"; downloaded: number; total: number | null }
  | { event: "installing" };

export const api = {
  initialPaths: () => invoke<string[]>("initial_paths"),
  readFile: (path: string, encoding?: string) => invoke<FileContent>("read_file", { path, encoding }),
  writeFile: (path: string, text: string, encoding: string, bom: boolean, eol: Eol) =>
    invoke<number>("write_file", { path, text, encoding, bom, eol }),
  writeBinary: (path: string, base64: string) => invoke<void>("write_binary", { path, base64 }),
  statFile: (path: string) => invoke<FileStat>("stat_file", { path }),
  statFiles: (paths: string[]) => invoke<FileStat[]>("stat_files", { paths }),

  largeOpen: (path: string) => invoke<LargeOpened>("large_open", { path }),
  largeInfo: (id: number) => invoke<LargeInfo>("large_info", { id }),
  largeLines: (id: number, start: number, count: number) =>
    invoke<LargeLine[]>("large_lines", { id, start, count }),
  largeSearch: (
    id: number,
    query: string,
    from: { line: number; col: number },
    forward: boolean,
    inclusive: boolean,
    matchCase: boolean,
    regex: boolean,
  ) => invoke<LargeSearchResult>("large_search", { id, query, ...from, forward, inclusive, matchCase, regex }),
  largeSearchCancel: (id: number) => invoke<void>("large_search_cancel", { id }),
  largeRefresh: (id: number) => invoke<LargeRefresh>("large_refresh", { id }),
  largeClose: (id: number) => invoke<void>("large_close", { id }),

  sessionLoad: () => invoke<string | null>("session_load"),
  sessionSave: (json: string) => invoke<void>("session_save", { json }),
  backupWrite: (id: string, text: string) => invoke<void>("backup_write", { id, text }),
  backupRead: (id: string) => invoke<string | null>("backup_read", { id }),
  backupVersions: (id: string) => invoke<BackupVersion[]>("backup_versions", { id }),
  backupReadVersion: (id: string, n: number) => invoke<string | null>("backup_read_version", { id, n }),
  backupPrune: (keep: string[]) => invoke<void>("backup_prune", { keep }),

  /** One LanguageTool check; resolves to the response JSON, rejects with { kind, status?, retryAfter?, message }. */
  languageToolCheck: (server: string, data: string, language: string, variants: string) =>
    invoke<string>("languagetool_check", { server, data, language, variants }),

  configRead: (name: string) => invoke<string | null>("config_read", { name }),
  configFile: (name: string, defaultContent: string) =>
    invoke<string>("config_file", { name, default: defaultContent }),
  configDir: () => invoke<string>("config_dir"),

  integrationStatus: () => invoke<IntegrationStatus>("integration_status"),
  integrationRegister: (groups: string[], contextMenu: boolean) =>
    invoke<void>("integration_register", { groups, contextMenu }),
  integrationOpenDefaultApps: () => invoke<void>("integration_open_default_apps"),
  integrationUnregister: () => invoke<void>("integration_unregister"),
  integrationDismissOffer: () => invoke<void>("integration_dismiss_offer"),

  /** manual: always ask; otherwise the check is skipped when one succeeded in the last 24 hours. */
  updateCheck: (manual: boolean) => invoke<UpdateInfo | null>("update_check", { manual }),
  /** Downloads and installs; the app exits and restarts through the installer when this succeeds. */
  updateInstall: (onEvent: (e: UpdateProgress) => void) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onEvent;
    return invoke<void>("update_install", { onEvent: channel });
  },
};
