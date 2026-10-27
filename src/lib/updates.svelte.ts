// Updates: a background check a few seconds after start (at most once a day, decided in Rust), the
// "Check for updates" command and the install flow behind the banner in UpdateBanner.svelte.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, type UpdateInfo } from "./api";
import { settings } from "./settings.svelte";
import { workspace } from "./workspace.svelte";

/** Long enough that the check never competes with opening the first files. */
const START_DELAY_MS = 5000;
const RELEASES_URL = "https://github.com/LukasDoubleU/Kladde/releases";

class Updates {
  /** The newer version the banner announces; null when there is none or the user said "Later". */
  available: UpdateInfo | null = $state(null);
  /** Status line while an update downloads and installs. */
  installing: string | null = $state(null);

  /** At start: wait, then check quietly unless the setting is off. */
  scheduleCheck() {
    setTimeout(() => {
      if (settings.checkForUpdates) void this.check(false);
    }, START_DELAY_MS);
  }

  /** The command always asks GitHub and always answers; the start-up check only speaks up for an update. */
  async check(manual: boolean) {
    if (this.installing) return;
    try {
      const info = await api.updateCheck(manual);
      if (info) this.available = info;
      else if (manual) {
        this.available = null;
        workspace.showNotice("info", `You’re up to date: Kladde ${await getVersion()} is the latest version.`);
      }
    } catch (e) {
      if (manual) workspace.showNotice("error", `Could not check for updates: ${e}`);
      else console.warn("Update check failed:", e);
    }
  }

  releaseUrl(info: UpdateInfo) {
    return `${RELEASES_URL}/tag/v${info.version}`;
  }

  openReleaseNotes() {
    if (this.available) void openUrl(this.releaseUrl(this.available));
  }

  later() {
    this.available = null;
  }

  /** Installed copies update in place; a portable exe opens the release page, where the new file is. */
  async install() {
    const info = this.available;
    if (!info || this.installing) return;
    if (info.portable) {
      void openUrl(this.releaseUrl(info));
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
