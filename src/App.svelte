<script lang="ts">
  import { openSearchPanel } from "@codemirror/search";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { onMount, untrack } from "svelte";
  import Dialog from "./components/Dialog.svelte";
  import ImageView from "./components/ImageView.svelte";
  import LargeFileView from "./components/LargeFileView.svelte";
  import Picker from "./components/Picker.svelte";
  import Preview from "./components/Preview.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import {
    allActions,
    defaultKeybindingsJson,
    handleKeydown,
    KEYBINDINGS_FILE,
    loadKeybindings,
    registerActions,
    runAction,
    shortcutLabel,
  } from "./lib/actions";
  import { api, type Eol } from "./lib/api";
  import { writeText } from "./lib/clipboard";
  import { languageNames } from "./lib/languages";
  import { dirname } from "./lib/markdown";
  import { defaultSettingsJson, loadSettings, settings, SETTINGS_FILE } from "./lib/settings.svelte";
  import { basename, ENCODINGS, workspace } from "./lib/workspace.svelte";

  const appWindow = getCurrentWindow();
  const tab = $derived(workspace.active);
  const showPreview = $derived(!!tab && tab.kind === "text" && tab.preview !== "off" && workspace.previewAvailable(tab));

  let editorHost: HTMLDivElement;
  let content: HTMLDivElement;
  let splitRatio = $state(0.5);
  let imageSize: { w: number; h: number } | null = $state(null);
  let dropping = $state(false);
  let systemDark = $state(window.matchMedia("(prefers-color-scheme: dark)").matches);
  let configDir = "";

  const textTab = () => workspace.active?.kind === "text";

  registerActions([
    { id: "file.new", label: "New file", keys: ["Ctrl+N"], run: () => workspace.newUntitled() },
    { id: "file.open", label: "Open file…", keys: ["Ctrl+O"], run: () => workspace.openWithDialog() },
    { id: "file.save", label: "Save", keys: ["Ctrl+S"], run: () => workspace.save(), enabled: textTab },
    { id: "file.saveAs", label: "Save as…", keys: ["Ctrl+Shift+S"], run: () => workspace.saveAs(), enabled: textTab },
    { id: "file.saveAll", label: "Save all", keys: ["Ctrl+Alt+S"], run: () => workspace.saveAll() },
    {
      id: "file.close",
      label: "Close tab",
      keys: ["Ctrl+W", "Ctrl+F4"],
      run: () => workspace.activeId && workspace.close(workspace.activeId),
    },
    { id: "file.reopenClosed", label: "Reopen closed tab", keys: ["Ctrl+Shift+T"], run: () => workspace.reopenClosed() },
    {
      id: "file.reload",
      label: "Reload from disk",
      run: async () => {
        const t = workspace.active;
        if (!t) return;
        if (t.dirty) {
          const choice = await workspace.ask(`Reloading ${t.title} discards your unsaved changes.`, [
            { id: "reload", label: "Reload", primary: true },
            { id: "cancel", label: "Cancel" },
          ]);
          if (choice !== "reload") return;
        }
        await workspace.reload(t, t.kind === "text" ? t.encoding : undefined);
      },
      enabled: () => !!workspace.active?.path,
    },
    {
      id: "file.copyPath",
      label: "Copy full path",
      run: () => writeText(workspace.active!.path!),
      enabled: () => !!workspace.active?.path,
    },
    {
      id: "file.reveal",
      label: "Reveal in Explorer",
      run: () => revealItemInDir(workspace.active!.path!),
      enabled: () => !!workspace.active?.path,
    },
    { id: "tab.next", label: "Next tab", keys: ["Ctrl+Tab", "Ctrl+PageDown"], run: () => workspace.cycle(1) },
    { id: "tab.previous", label: "Previous tab", keys: ["Ctrl+Shift+Tab", "Ctrl+PageUp"], run: () => workspace.cycle(-1) },
    { id: "view.commandPalette", label: "Show all commands", keys: ["Ctrl+Shift+P", "F1"], run: commandPalette },
    {
      id: "view.togglePreview",
      label: "Toggle Markdown preview",
      keys: ["Ctrl+Shift+V"],
      run: () => workspace.togglePreview(),
      enabled: textTab,
    },
    { id: "view.toggleWrap", label: "Toggle word wrap", keys: ["Alt+Z"], run: () => workspace.toggleWrap() },
    { id: "view.zoomIn", label: "Zoom in", keys: ["Ctrl+Plus", "Ctrl+="], run: () => workspace.zoom(1) },
    { id: "view.zoomOut", label: "Zoom out", keys: ["Ctrl+Minus"], run: () => workspace.zoom(-1) },
    { id: "view.zoomReset", label: "Reset zoom", keys: ["Ctrl+0"], run: () => workspace.zoom(null) },
    { id: "edit.gotoLine", label: "Go to line…", keys: ["Ctrl+G"], run: () => workspace.gotoLine() },
    {
      id: "edit.replace",
      label: "Find and replace",
      keys: ["Ctrl+H"],
      run: () => {
        if (workspace.active?.kind === "large") workspace.largeApi?.focusSearch();
        else if (workspace.view) openSearchPanel(workspace.view);
      },
    },
    { id: "language.select", label: "Change language mode…", run: selectLanguage, enabled: textTab },
    { id: "encoding.select", label: "Change encoding…", run: selectEncoding, enabled: textTab },
    { id: "eol.select", label: "Change line endings…", run: selectEol, enabled: textTab },
    {
      id: "settings.open",
      label: "Open settings (settings.json)",
      run: async () => workspace.openPath(await api.configFile(SETTINGS_FILE, defaultSettingsJson())),
    },
    {
      id: "keybindings.open",
      label: "Open keyboard shortcuts (keybindings.json)",
      run: async () => workspace.openPath(await api.configFile(KEYBINDINGS_FILE, defaultKeybindingsJson())),
    },
  ]);

  async function commandPalette() {
    const items = allActions()
      .filter((a) => a.id !== "view.commandPalette")
      .map((a) => ({ id: a.id, label: a.label, detail: shortcutLabel(a.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const picked = await workspace.pick({ placeholder: "Type a command", items });
    if (picked && typeof picked !== "string") runAction(picked.id);
  }

  async function selectLanguage() {
    const t = workspace.active;
    if (!t) return;
    const items = [
      { id: "", label: "Plain Text" },
      ...languageNames().map((name) => ({ id: name, label: name, detail: name === t.language ? "current" : "" })),
    ];
    const picked = await workspace.pick({ placeholder: "Select language mode", items });
    if (picked && typeof picked !== "string") workspace.setLanguage(t, picked.id || null);
  }

  async function selectEncoding() {
    const t = workspace.active;
    if (!t) return;
    const how = await workspace.pick({
      placeholder: "Change encoding",
      items: [
        { id: "reopen", label: "Reopen with encoding…", detail: "decode the file differently" },
        { id: "convert", label: "Save with encoding…", detail: "convert on next save" },
      ],
    });
    if (!how || typeof how === "string") return;
    const current = t.encoding === "UTF-8" && t.bom ? "UTF-8 BOM" : t.encoding;
    const items = ENCODINGS.map((e) => ({ ...e, detail: e.id === current ? "current" : (e.detail ?? "") }));
    const picked = await workspace.pick({ placeholder: "Select encoding", items });
    if (!picked || typeof picked === "string") return;
    if (how.id === "reopen") await workspace.reopenWithEncoding(t, picked.id);
    else workspace.convertEncoding(t, picked.id);
  }

  async function selectEol() {
    const t = workspace.active;
    if (!t) return;
    const items = [
      { id: "CRLF", label: "CRLF", detail: "Windows" },
      { id: "LF", label: "LF", detail: "Unix, macOS" },
      { id: "CR", label: "CR", detail: "classic Mac" },
    ].map((e) => ({ ...e, detail: e.id === t.eol ? `${e.detail} · current` : e.detail }));
    const picked = await workspace.pick({ placeholder: "Select line endings", items });
    if (picked && typeof picked !== "string") workspace.setEol(t, picked.id as Eol);
  }

  async function reloadConfig(path: string) {
    if (!configDir || dirname(path).toLowerCase() !== configDir.toLowerCase()) return;
    const name = basename(path);
    if (name === SETTINGS_FILE) {
      const error = await loadSettings();
      workspace.showNotice(error ? "error" : "info", error ?? "Settings applied.");
    } else if (name === KEYBINDINGS_FILE) {
      const error = await loadKeybindings();
      workspace.showNotice(error ? "error" : "info", error ?? "Keyboard shortcuts applied.");
    }
  }

  // Shortcuts the WebView would otherwise handle itself: reload, print, downloads, caret browsing, …
  const BROWSER_KEYS = new Set(["F5", "F7", "ctrl+r", "ctrl+p", "ctrl+j", "ctrl+u", "ctrl+shift+r"]);
  // Find shortcuts belong to CodeMirror and the large file view; anywhere else the WebView's find bar would open.
  const FIND_KEYS = new Set(["ctrl+f", "ctrl+g", "f3"]);

  function onKeydown(e: KeyboardEvent) {
    if (workspace.picker || workspace.dialog) return;
    if (handleKeydown(e)) return;
    const combo = [e.ctrlKey && "ctrl", e.shiftKey && "shift", e.key.length === 1 ? e.key.toLowerCase() : e.key]
      .filter(Boolean)
      .join("+");
    const inEditor = !!(e.target as HTMLElement).closest(".cm-editor, .large");
    if (BROWSER_KEYS.has(combo) || (FIND_KEYS.has(combo.toLowerCase()) && !inEditor)) e.preventDefault();
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    workspace.zoom(e.deltaY < 0 ? 1 : -1);
  }

  function onContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".cm-content, input, textarea, .markdown, .lines")) e.preventDefault();
  }

  // Draggable divider between editor and preview.
  function onDividerDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = content.getBoundingClientRect();
      splitRatio = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  }

  $effect(() => {
    const dark = settings.theme === "dark" || (settings.theme === "system" && systemDark);
    document.documentElement.classList.toggle("dark", dark);
    // Match the native title bar.
    void appWindow.setTheme(dark ? "dark" : "light");
  });

  $effect(() => {
    const root = document.documentElement.style;
    root.setProperty("--editor-font", settings.fontFamily);
    root.setProperty("--editor-font-size", `${Math.max(6, settings.fontSize + workspace.ui.zoom)}px`);
    workspace.view?.requestMeasure();
  });

  $effect(() => {
    // Re-apply editor options whenever settings change.
    void [settings.tabSize, settings.insertSpaces, settings.lineNumbers, settings.highlightActiveLine];
    untrack(() => workspace.applyViewOptions());
  });

  $effect(() => {
    const t = workspace.active;
    const title = t ? `${t.dirty ? "● " : ""}${t.title} – Kladde` : "Kladde";
    void appWindow.setTitle(title);
  });

  $effect(() => {
    void workspace.activeId;
    imageSize = null;
  });

  onMount(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (systemDark = media.matches);
    media.addEventListener("change", onScheme);
    const cleanups: (() => void)[] = [() => media.removeEventListener("change", onScheme)];

    void (async () => {
      const errors = [await loadSettings(), await loadKeybindings()].filter(Boolean);
      configDir = await api.configDir();
      workspace.onConfigSaved = (path) => void reloadConfig(path);
      workspace.attachView(editorHost);
      await workspace.restoreSession();
      await workspace.openPaths(await api.initialPaths());
      await appWindow.show();
      await appWindow.setFocus();
      if (errors.length) workspace.showNotice("error", errors.join(" "));

      cleanups.push(await listen<string[]>("open-paths", (e) => void workspace.openPaths(e.payload)));
      cleanups.push(
        await getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type === "enter" || e.payload.type === "over") dropping = true;
          else if (e.payload.type === "leave") dropping = false;
          else if (e.payload.type === "drop") {
            dropping = false;
            void workspace.openPaths(e.payload.paths);
          }
        }),
      );
      cleanups.push(
        await appWindow.onFocusChanged(({ payload: focused }) => {
          if (focused) void workspace.checkExternalChanges();
        }),
      );
      // Hot exit: everything, including unsaved text, is restored on the next start.
      cleanups.push(await appWindow.onCloseRequested(() => workspace.saveSession()));
      // Follow the active file while the window has focus, e.g. a growing log.
      const timer = setInterval(() => {
        const t = workspace.active;
        if (t?.path && document.hasFocus()) void workspace.checkExternalChanges(t);
      }, 2000);
      cleanups.push(() => clearInterval(timer));
    })();

    return () => cleanups.forEach((c) => c());
  });
</script>

<svelte:window onkeydowncapture={onKeydown} onwheelcapture={onWheel} oncontextmenu={onContextMenu} />

<div class="app">
  <TabBar />

  {#if tab?.external}
    <div class="banner">
      {#if tab.external === "modified"}
        <span>This file was changed by another program.</span>
        <button onclick={() => workspace.reload(tab, tab.kind === "text" ? tab.encoding : undefined)}>
          Reload{tab.dirty ? " (discard my changes)" : ""}
        </button>
        {#if tab.kind === "text"}<button onclick={() => workspace.keepMine(tab)}>Keep my version</button>{/if}
      {:else}
        <span>This file was deleted or moved.</span>
        {#if tab.kind === "text"}<button onclick={() => workspace.keepMine(tab)}>Keep in editor</button>{/if}
        <button onclick={() => workspace.close(tab.id)}>Close tab</button>
      {/if}
    </div>
  {/if}

  <div class="content" bind:this={content}>
    <div
      class="editor"
      class:hidden={tab?.kind !== "text" || (showPreview && tab.preview === "only")}
      style:flex-basis={showPreview && tab?.preview === "split" ? `${splitRatio * 100}%` : "100%"}
      bind:this={editorHost}
    ></div>
    {#if showPreview && tab}
      {#if tab.preview === "split"}
        <div class="divider" onpointerdown={onDividerDown} role="separator" aria-orientation="vertical"></div>
      {/if}
      <div class="preview-pane">
        <Preview
          html={workspace.previewHtml}
          baseDir={tab.path ? dirname(tab.path) : null}
          follow={tab.preview === "split"}
        />
      </div>
    {/if}
    {#if tab?.kind === "large"}
      {#key tab.id}
        <div class="fill"><LargeFileView {tab} /></div>
      {/key}
    {:else if tab?.kind === "image"}
      {#key tab.id}
        <div class="fill"><ImageView {tab} onsize={(s) => (imageSize = s)} /></div>
      {/key}
    {/if}
  </div>

  <StatusBar {imageSize} />

  {#if workspace.notice}
    <div class="notice" class:error={workspace.notice.kind === "error"} role="status">
      <span>{workspace.notice.text}</span>
      <button onclick={() => (workspace.notice = null)}>×</button>
    </div>
  {/if}

  {#if dropping}
    <div class="drop">Drop files to open them</div>
  {/if}
</div>

{#if workspace.picker}<Picker />{/if}
{#if workspace.dialog}<Dialog />{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }
  .content {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .editor {
    min-width: 0;
    flex-grow: 0;
    flex-shrink: 0;
    height: 100%;
  }
  .editor.hidden {
    display: none;
  }
  .preview-pane,
  .fill {
    flex: 1;
    min-width: 0;
    height: 100%;
  }
  .divider {
    width: 5px;
    margin: 0 -2px;
    z-index: 1;
    cursor: col-resize;
    flex: none;
    background: linear-gradient(to right, transparent 2px, var(--border) 2px, var(--border) 3px, transparent 3px);
  }
  .divider:hover {
    background: var(--accent);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    background: var(--banner);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .banner button {
    border: 1px solid var(--border);
    background: var(--bg);
    border-radius: 4px;
    padding: 2px 10px;
  }
  .notice {
    position: absolute;
    right: 16px;
    bottom: 36px;
    max-width: min(520px, calc(100% - 32px));
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 6px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.2);
    z-index: 40;
    user-select: text;
  }
  .notice.error {
    border-left-color: var(--error);
  }
  .notice button {
    border: none;
    background: none;
    font-size: 16px;
    line-height: 1;
    color: var(--fg-dim);
  }
  .drop {
    position: absolute;
    inset: 34px 0 24px;
    display: grid;
    place-items: center;
    font-size: 18px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border: 2px dashed var(--accent);
    pointer-events: none;
    z-index: 30;
  }
</style>
