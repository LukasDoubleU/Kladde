// Updates: a background check a few seconds after start and then every few hours while Kladde is open (the
// throttle of one hour is decided in Rust, so a restart does not ask twice), the "Check for updates" command, the
// header of the settings page and the install flow behind the banner in UpdateBanner.svelte.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type UpdateInfo } from "./api";
import { settings } from "./settings.svelte";
import { workspace } from "./workspace.svelte";

/** Long enough that the check never competes with opening the first files. */
const START_DELAY_MS = 5000;
/** The period of the timer comes from Rust (`update_status`); this is only the fallback. */
const DEFAULT_PERIOD_S = 6 * 60 * 60;
const RELEASES_URL = "https://github.com/LukasDoubleU/Kladde/releases";

/** What the last check by hand said, for the settings page; an update that was found is `available` instead. */
export type CheckResult = { kind: "current" } | { kind: "error"; message: string };

class Updates {
  /** The newer version the banner announces; null when there is none or the user said "Later". */
  available: UpdateInfo | null = $state(null);
  /** Status line while an update downloads and installs. */
  installing: string | null = $state(null);
  /** Checks running (by hand or in the background); a manual one can start while an automatic one runs. */
  private running = $state(0);
  /** Outcome of the last check by hand; null before one and while an update is announced. */
  result: CheckResult | null = $state(null);
  /** The running version, for the settings page; empty until `loadStatus` has asked. */
  version = $state("");
  /** Unix seconds of the last completed check; null when there was none. */
  lastCheck: number | null = $state(null);
  /** The version the user dismissed with "Later": the automatic checks stay quiet about it until the next start. */
  private dismissed: string | null = null;

  /** At start: wait, then check quietly unless the setting is off; from then on again every few hours. */
  scheduleCheck() {
    const automatic = () => {
      if (settings.checkForUpdates && !this.checking) void this.check(false);
    };
    setTimeout(async () => {
      automatic();
      const status = await api.updateStatus().catch(() => null);
      // The setting is read at every tick, so turning it on later takes effect without a restart.
      setInterval(automatic, (status?.periodSecs ?? DEFAULT_PERIOD_S) * 1000);
    }, START_DELAY_MS);
  }

  /** A check is running. */
  get checking() {
    return this.running > 0;
  }

  /** What the settings page shows besides the result: the version and the time of the last completed check. */
  async loadStatus() {
    try {
      if (!this.version) this.version = await getVersion();
      this.lastCheck = (await api.updateStatus()).lastCheck;
    } catch (e) {
      console.warn("Update status unavailable:", e);
    }
  }

  /**
   * The command and "Check now" always ask GitHub and always answer; the automatic checks only speak up for an
   * update, and not for one the user dismissed. `quiet`: the caller shows the answer itself (settings page).
   */
  async check(manual: boolean, quiet = false) {
    if (this.installing) return;
    this.running++;
    if (manual) this.result = null;
    try {
      const info = await api.updateCheck(manual);
      if (info) {
        if (manual || info.version !== this.dismissed) {
          this.available = info;
          this.result = null;
        }
      } else if (manual) {
        this.available = null;
        this.result = { kind: "current" };
        if (!quiet) workspace.showNotice("info", `You’re up to date: Kladde ${await getVersion()} is the latest version.`);
      }
    } catch (e) {
      if (manual) {
        this.result = { kind: "error", message: String(e) };
        if (!quiet) workspace.showNotice("error", `Could not check for updates: ${e}`);
      } else console.warn("Update check failed:", e);
    } finally {
      this.running--;
      void this.loadStatus();
    }
  }

  /** The GitHub release page of a version. */
  releaseUrl(version: string) {
    return `${RELEASES_URL}/tag/v${version}`;
  }

  openRelease(version: string) {
    void openUrl(this.releaseUrl(version));
  }

  openReleaseNotes() {
    if (this.available) this.openRelease(this.available.version);
  }

  later() {
    if (this.available) this.dismissed = this.available.version;
    this.available = null;
  }

  /** Installed copies update in place; a portable exe opens the release page, where the new file is. */
  async install() {
    const info = this.available;
    if (!info || this.installing) return;
    if (info.portable) {
      this.openRelease(info.version);
      return;
    }
    this.installing = `Downloading Kladde ${info.version}…`;
    try {
      // The installer ends the app without a word: make sure unsaved text is on disk first (hot exit).
      await workspace.saveSession();
      await api.updateInstall((e) => {
        if (e.event === "installing") this.installing = `Installing Kladde ${info.version}…`;
        else if (e.total) {
          this.installing = `Downloading Kladde ${info.version}… ${Math.floor((e.downloaded / e.total) * 100)} %`;
        }
      });
    } catch (e) {
      workspace.showNotice("error", `Could not install the update: ${e}`);
    } finally {
      this.installing = null;
    }
  }
}

export const updates = new Updates();
