// Windows integration: "Open with" / default apps registration and the Explorer context menu entry.
// The Rust side (src-tauri/src/integration.rs) writes the registry; this file is the user-facing flow.
import { api, type IntegrationStatus } from "./api";
import { settings } from "./settings.svelte";
import { workspace } from "./workspace.svelte";

class Integration {
  /** The start-up offer banner is showing. */
  offer = $state(false);
  /** The "choose file types" dialog; null while closed. */
  setup: { status: IntegrationStatus } | null = $state(null);

  /** At start: refresh a stale registration quietly, or offer one if Kladde is not registered. */
  async check() {
    let status: IntegrationStatus;
    try {
      status = await api.integrationStatus();
    } catch (e) {
      console.error(e);
      return;
    }
    if (status.present && !status.current) {
      // The user chose this before; keep it working after the exe moved or the file type list grew.
      try {
        await api.integrationRegister(status.groups, status.contextMenu);
      } catch (e) {
        workspace.showNotice("error", `Could not update the Windows file associations: ${e}`);
      }
    } else if (status.offer && settings.offerDefaultEditor) {
      this.offer = true;
    }
  }

  /** "Set Kladde as default editor…": choose what to register. */
  async openSetup() {
    this.offer = false;
    try {
      this.setup = { status: await api.integrationStatus() };
    } catch (e) {
      workspace.showNotice("error", `Could not read the Windows file associations: ${e}`);
    }
  }

  closeSetup() {
    this.setup = null;
    if (workspace.active?.kind === "text") requestAnimationFrame(() => workspace.view?.focus());
  }

  /** Registers the chosen types, then sends the user to Windows' settings where the default is picked. */
  async register(groups: string[], contextMenu: boolean) {
    this.closeSetup();
    try {
      await api.integrationRegister(groups, contextMenu);
    } catch (e) {
      workspace.showNotice("error", `Could not register Kladde with Windows: ${e}`);
      return;
    }
    if (groups.length) {
      workspace.showNotice("info", "Kladde is registered. Choose it for the file types in the Windows settings.");
      await api.integrationOpenDefaultApps();
    } else {
      workspace.showNotice("info", "“Edit with Kladde” is in the Explorer context menu.");
    }
  }

  async dismissOffer() {
    this.offer = false;
    await api.integrationDismissOffer().catch(console.error);
  }

  async remove() {
    try {
      await api.integrationUnregister();
      workspace.showNotice("info", "Kladde was removed from the Windows file associations and the context menu.");
    } catch (e) {
      workspace.showNotice("error", `Could not remove the Windows file associations: ${e}`);
    }
  }

  /** Adds or removes only the context menu entry; registered file types stay as they are. */
  async toggleContextMenu() {
    try {
      const status = await api.integrationStatus();
      if (status.contextMenu && !status.groups.length) {
        await api.integrationUnregister();
      } else {
        await api.integrationRegister(status.groups, !status.contextMenu);
      }
      workspace.showNotice(
        "info",
        status.contextMenu
          ? "“Edit with Kladde” was removed from the context menu."
          : "“Edit with Kladde” is in the Explorer context menu.",
      );
    } catch (e) {
      workspace.showNotice("error", `Could not change the context menu: ${e}`);
    }
  }
}

export const integration = new Integration();
