import { invoke } from "@tauri-apps/api/core";
import { mount } from "svelte";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "./app.css";
import App from "./App.svelte";
import { workspace } from "./lib/workspace.svelte";

function reportError(error: unknown) {
  const message = error instanceof Error ? `${error.message}
${error.stack ?? ""}` : String(error);
  void invoke("frontend_log", { message });
  workspace.showNotice("error", `Unexpected error: ${error instanceof Error ? error.message : error}`);
}

window.addEventListener("error", (e) => reportError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason));

const app = mount(App, { target: document.getElementById("app")! });

export default app;
