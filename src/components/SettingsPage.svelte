<script lang="ts">
  import { untrack } from "svelte";
  import { runAction } from "../lib/actions";
  import LocalLanguageTool from "./LocalLanguageTool.svelte";
  import {
    coerceSetting,
    SETTING_GROUPS,
    SETTING_META,
    type SettingGroup,
    settingMatches,
    settingNames,
    type Settings,
  } from "../lib/settings-schema";
  import { defaultSettings, settings, settingsStatus, updateSettingsFile } from "../lib/settings.svelte";
  import { formatLastCheck } from "../lib/update-time";
  import { updates } from "../lib/updates.svelte";
  import { workspace } from "../lib/workspace.svelte";

  let { active }: { active: boolean } = $props();

  type Name = keyof Settings;
  const current = (name: Name): unknown => settings[name];
  const isChanged = (name: Name) => current(name) !== defaultSettings[name];

  let query = $state("");
  let search: HTMLInputElement | undefined = $state();

  const names = settingNames();
  const sections = $derived(
    SETTING_GROUPS.map((group) => ({
      ...group,
      names: names.filter((n) => SETTING_META[n].group === group.id && settingMatches(n, query)),
    })).filter((g) => g.names.length > 0),
  );
  const shown = $derived(sections.reduce((sum, g) => sum + g.names.length, 0));

  // What each section offers besides its settings: the files that hold what the page does not.
  const LINKS: Partial<Record<SettingGroup, { label: string; command: string }[]>> = {
    appearance: [{ label: "Open theme.css", command: "theme.openCustom" }],
    keys: [
      { label: "Change keyboard shortcut…", command: "keybindings.change" },
      { label: "Open keybindings.json", command: "keybindings.open" },
    ],
  };

  // The page is kept alive while another tab is active (it keeps its search and scroll position); the search
  // box takes the focus whenever the tab comes back.
  $effect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      if (!search || workspace.picker || workspace.dialog) return;
      search.focus();
      search.select();
    });
  });

  // The version and the time of the last check are read again whenever the tab comes back: a check in the
  // background may have completed meanwhile.
  $effect(() => {
    if (active) untrack(() => void updates.loadStatus());
  });

  /** Writes entries of settings.json and applies them; the three that mirror a session state follow it too. */
  async function write(name: Name, value: unknown) {
    const error = await updateSettingsFile({ [name]: value === defaultSettings[name] ? undefined : value });
    if (error) workspace.showNotice("error", error);
    else if (name === "wordWrap" || name === "spellCheck" || name === "grammarCheck") workspace.followSetting(name);
  }

  /** Writes the new value of a setting. A value equal to the default removes the entry from settings.json. */
  async function commit(name: Name, raw: unknown, input?: HTMLInputElement | HTMLSelectElement) {
    const value = coerceSetting(name, raw);
    if (value !== null) await write(name, value);
    // The control shows what is really set: a number clamped to its range, or a value that was refused.
    if (input) input.value = String(current(name));
  }

  const reset = (name: Name) => write(name, defaultSettings[name]);

  /** A value as the page prints it next to "Default". */
  function describe(name: Name, value: unknown): string {
    const control = SETTING_META[name].control;
    if (control.type === "boolean") return value ? "on" : "off";
    if (control.type === "choice") return control.choices.find((c) => c.value === value)?.label ?? String(value);
    if (control.type === "number") return `${value}${control.unit ? ` ${control.unit}` : ""}`;
    return value === "" ? "empty" : `“${value}”`;
  }

  /** A real link (the address shows on hover), opened in the browser instead of in the app's webview. */
  function openRelease(e: MouseEvent, version: string) {
    e.preventDefault();
    updates.openRelease(version);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // First the search text, then the page.
    if (e.target === search && query) query = "";
    else workspace.leaveSettings();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="page" class:hidden={!active} role="region" aria-label="Settings" onkeydown={onKeydown}>
  <!-- Above the search and not part of it: the version and the update check are always at hand. -->
  <div class="about" role="group" aria-label="Kladde version and updates">
    <div class="line">
      {#if updates.version}
        <strong class="version">Kladde {updates.version}</strong>
        <a class="link" href={updates.releaseUrl(updates.version)} onclick={(e) => openRelease(e, updates.version)}>
          Release notes
        </a>
      {/if}
      <span class="last">Last checked: {formatLastCheck(updates.lastCheck)}</span>
      <button class="check" disabled={updates.checking || !!updates.installing} onclick={() => updates.check(true, true)}>
        Check now
      </button>
    </div>
    {#if updates.installing || updates.checking || updates.available || updates.result}
      <div class="line outcome" role="status">
        {#if updates.installing}
          <span>{updates.installing} Kladde restarts when it is done.</span>
        {:else if updates.checking}
          <span class="dim">Checking…</span>
        {:else if updates.available}
          {@const info = updates.available}
          <span>Kladde {info.version} is available.</span>
          <button onclick={() => updates.install()}>{info.portable ? "Download" : "Update now"}</button>
          <a class="link" href={updates.releaseUrl(info.version)} onclick={(e) => openRelease(e, info.version)}>
            Release notes
          </a>
        {:else if updates.result?.kind === "error"}
          <span class="problem-text">Could not check for updates: {updates.result.message}</span>
        {:else}
          <span class="dim">Up to date</span>
        {/if}
      </div>
    {/if}
  </div>

  <header>
    <div class="bar">
      <input
        class="search"
        type="text"
        role="searchbox"
        bind:this={search}
        bind:value={query}
        placeholder="Search settings"
        aria-label="Search settings"
        spellcheck="false"
        autocomplete="off"
      />
      <button onclick={() => runAction("settings.open")} title="Edit the file directly; saving it applies the changes">
        Open settings.json
      </button>
    </div>
    {#if settingsStatus.error}
      <p class="problem" role="alert">{settingsStatus.error}</p>
    {/if}
  </header>

  <main>
    {#each sections as group (group.id)}
      <section aria-labelledby="group-{group.id}" data-group={group.id}>
        <h2 id="group-{group.id}">{group.label}</h2>
        {#if group.id === "spelling"}<LocalLanguageTool {active} />{/if}
        {#each group.names as name (name)}
          {@const meta = SETTING_META[name]}
          {@const control = meta.control}
          {@const value = current(name)}
          {@const changed = isChanged(name)}
          <div class="row" class:changed data-setting={name}>
            <div class="text">
              <div class="title">
                <label id="label-{name}" for="setting-{name}">{meta.label}</label>
                {#if changed}
                  <span class="mark" title="Differs from the default ({describe(name, defaultSettings[name])})">modified</span>
                {/if}
              </div>
              <p class="description">{meta.description}</p>
              <code class="name">{name}</code>
            </div>
            <div class="control">
              {#if control.type === "boolean"}
                <button
                  id="setting-{name}"
                  class="switch"
                  class:on={value === true}
                  role="switch"
                  aria-checked={value === true}
                  aria-labelledby="label-{name}"
                  onclick={() => commit(name, value !== true)}
                >
                  <span class="knob"></span>
                </button>
              {:else if control.type === "number"}
                <input
                  id="setting-{name}"
                  type="number"
                  min={control.min}
                  max={control.max}
                  step="1"
                  value={value as number}
                  onchange={(e) => commit(name, e.currentTarget.value, e.currentTarget)}
                />
                {#if control.unit}<span class="unit">{control.unit}</span>{/if}
              {:else if control.type === "choice"}
                <select id="setting-{name}" onchange={(e) => commit(name, e.currentTarget.value, e.currentTarget)}>
                  {#each control.choices as choice (choice.value)}
                    <option value={choice.value} selected={choice.value === value}>{choice.label}</option>
                  {/each}
                  <!-- A value written by hand that the list does not know (an old name, another language code). -->
                  {#if !control.choices.some((c) => c.value === value)}
                    <option value={String(value)} selected disabled>{String(value)}</option>
                  {/if}
                </select>
              {:else}
                <input
                  id="setting-{name}"
                  class="wide"
                  type="text"
                  value={value as string}
                  placeholder={control.placeholder ?? ""}
                  spellcheck="false"
                  autocomplete="off"
                  onchange={(e) => commit(name, e.currentTarget.value, e.currentTarget)}
                />
              {/if}
              <button class="reset" class:invisible={!changed} disabled={!changed} onclick={() => reset(name)}>
                Reset to default
              </button>
            </div>
          </div>
        {/each}
        {#if LINKS[group.id]}
          <div class="links">
            {#each LINKS[group.id]! as link (link.command)}
              <button onclick={() => runAction(link.command)}>{link.label}</button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
    {#if shown === 0}
      <p class="empty" role="status">No setting matches “{query}”.</p>
    {/if}
  </main>
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    background: var(--bg);
  }
  .page.hidden {
    display: none;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 12px 24px 10px;
  }
  .about,
  .bar,
  main {
    max-width: 880px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    gap: 10px;
  }
  .about {
    padding: 14px 24px 2px;
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    align-items: center;
    min-height: 28px;
  }
  .version {
    font-size: 14px;
  }
  .link {
    color: var(--link);
  }
  .link:hover {
    text-decoration: underline;
  }
  .last {
    margin-left: auto;
    color: var(--fg-dim);
  }
  .outcome {
    padding-bottom: 6px;
  }
  .dim {
    color: var(--fg-dim);
  }
  .problem-text {
    color: var(--error);
  }
  main {
    padding: 4px 24px 40px;
  }
  .search {
    flex: 1;
    font: inherit;
    font-size: 14px;
    padding: 6px 10px;
    color: var(--fg);
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .search:focus,
  select:focus,
  input[type="number"]:focus,
  input.wide:focus {
    outline: none;
    border-color: var(--accent);
  }
  button {
    border: 1px solid var(--border);
    background: var(--bg-alt);
    border-radius: 4px;
    padding: 4px 12px;
  }
  button:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  button:disabled {
    opacity: 0.5;
  }
  button:focus-visible,
  .link:focus-visible,
  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .problem {
    max-width: 880px;
    margin: 8px auto 0;
    color: var(--error);
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin: 26px 0 4px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .row {
    display: flex;
    gap: 24px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 12px 0 12px 10px;
    border-left: 3px solid transparent;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  }
  .row.changed {
    border-left-color: var(--accent);
  }
  .text {
    min-width: 0;
    flex: 1;
  }
  .title {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  label {
    font-size: 13.5px;
    font-weight: 600;
  }
  .mark {
    font-size: 11px;
    color: var(--accent);
  }
  .description {
    margin: 3px 0 4px;
    color: var(--fg-dim);
    line-height: 1.4;
  }
  .name {
    font-family: var(--editor-font);
    font-size: 11px;
    color: var(--fg-dim);
    opacity: 0.8;
  }
  .control {
    flex: none;
    display: flex;
    gap: 10px;
    align-items: center;
    padding-top: 1px;
  }
  .reset {
    padding: 3px 9px;
    font-size: 12px;
    color: var(--fg-dim);
  }
  /* Keeps the controls aligned whether or not a setting is modified. */
  .invisible {
    visibility: hidden;
  }
  select,
  input[type="number"],
  input.wide {
    font: inherit;
    color: var(--fg);
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
  }
  select {
    min-width: 180px;
  }
  input[type="number"] {
    width: 90px;
  }
  input.wide {
    width: 260px;
  }
  .unit {
    color: var(--fg-dim);
    width: 50px;
  }
  .switch {
    position: relative;
    width: 38px;
    height: 22px;
    padding: 0;
    border-radius: 11px;
    background: var(--border);
  }
  .switch.on {
    background: var(--accent);
    border-color: var(--accent);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--fg-dim);
    transition: transform 0.12s;
  }
  .switch.on .knob {
    transform: translateX(16px);
    background: var(--accent-fg);
  }
  .links {
    display: flex;
    gap: 10px;
    padding: 12px 0 0 13px;
  }
  .empty {
    margin-top: 40px;
    text-align: center;
    color: var(--fg-dim);
  }
</style>
