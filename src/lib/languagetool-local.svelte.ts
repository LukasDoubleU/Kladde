// The local LanguageTool that Kladde downloads, starts and stops itself (src-tauri/src/lt_install.rs and
// lt_server.rs): what is installed, the progress of the download, whether the server runs. Used by the settings
// page, the status bar and the grammar commands. It does not talk to the user (notices and dialogs are the
// workspace's job), so it can be imported from everywhere.
import { listen } from "@tauri-apps/api/event";
import { api, type LocalInstallError, type LocalLanguageTool } from "./api";

export type InstallOutcome = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** What the server process is doing, as Rust reports it. */
export type ServerState = "stopped" | "starting" | "running";

class LocalLanguageToolStore {
  /** What is installed; null until the first `refresh`. */
  info: LocalLanguageTool | null = $state(null);
  server: ServerState = $state("stopped");
  /** The download or installation is running. */
  busy = $state(false);
  /** Its progress: bytes downloaded or unpacked, `total` 0 until the first report. */
  progress: { phase: "downloading" | "extracting"; done: number; total: number } | null = $state(null);
  /** Cancel was requested and the download has not stopped yet. */
  cancelling = $state(false);
  private listening = false;

  get installed() {
    return this.info?.installed === true;
  }

  /** "Downloading LanguageTool… 42 %" while an install runs, otherwise null. */
  get label(): string | null {
    const p = this.progress;
    if (!this.busy || !p) return null;
    const percent = p.total > 0 ? ` ${Math.min(100, Math.floor((p.done / p.total) * 100))} %` : "";
    if (this.cancelling) return "Cancelling…";
    return `${p.phase === "downloading" ? "Downloading" : "Unpacking"} LanguageTool…${percent}`;
  }

  /** Starts following the server's state; harmless to call again. Nothing is asked of Rust here. */
  async init() {
    if (this.listening) return;
    this.listening = true;
    try {
      await listen<ServerState>("languagetool-state", (e) => {
        this.server = e.payload;
        if (this.info) this.info.running = e.payload === "running";
      });
    } catch (e) {
      this.listening = false;
      console.warn("LanguageTool state unavailable:", e);
    }
  }

  /** Reads what is installed and whether the server runs. */
  async refresh(): Promise<LocalLanguageTool | null> {
    void this.init();
    try {
      this.info = await api.languageToolLocalStatus();
      this.server = this.info.running ? "running" : this.server === "starting" ? "starting" : "stopped";
    } catch (e) {
      console.warn("LanguageTool status unavailable:", e);
    }
    return this.info;
  }

  /** Downloads and installs LanguageTool and Java; resolves when done, failed or cancelled. */
  async install(): Promise<InstallOutcome> {
    if (this.busy) return { ok: false, cancelled: false, message: "LanguageTool is already being downloaded." };
    this.busy = true;
    this.cancelling = false;
    this.progress = { phase: "downloading", done: 0, total: 0 };
    try {
      await api.languageToolLocalInstall((e) => {
        this.progress =
          e.event === "downloading"
            ? { phase: "downloading", done: e.downloaded, total: e.total }
            : { phase: "extracting", done: e.done, total: e.total };
      });
      return { ok: true };
    } catch (e) {
      const error = e as Partial<LocalInstallError> | null;
      return { ok: false, cancelled: error?.kind === "cancelled", message: error?.message ?? String(e) };
    } finally {
      this.busy = false;
      this.progress = null;
      this.cancelling = false;
      await this.refresh();
    }
  }

  cancel() {
    if (!this.busy || this.cancelling) return;
    this.cancelling = true;
    void api.languageToolLocalCancel();
  }

  /** Stops the server (grammar checking was turned off); it starts again with the next check. */
  async stop() {
    try {
      await api.languageToolLocalStop();
    } catch (e) {
      console.warn("Could not stop LanguageTool:", e);
    }
  }

  /** Deletes the install; returns an error message, or null when it is gone. */
  async remove(): Promise<string | null> {
    try {
      await api.languageToolLocalRemove();
      return null;
    } catch (e) {
      return String(e);
    } finally {
      await this.refresh();
    }
  }
}

export const localLanguageTool = new LocalLanguageToolStore();
