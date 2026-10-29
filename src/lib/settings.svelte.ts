// User settings, read from settings.json in the app's config folder.
import { api } from "./api";
import { readConfigObject, writeConfigFile } from "./config-files";
import { defaultSettings, type Settings } from "./settings-schema";
import { THEME_CHOICES } from "./theme";

export { defaultSettings, type Settings };

export const SETTINGS_FILE = "settings.json";

export const settings: Settings = $state({ ...defaultSettings });

/** What the last load of settings.json reported, so that the settings page can say so. */
export const settingsStatus: { error: string | null } = $state({ error: null });

/** Loads settings.json over the defaults. Returns an error message if the file is invalid. */
export async function loadSettings(): Promise<string | null> {
  const text = await api.configRead(SETTINGS_FILE);
  const next = { ...defaultSettings };
  let error: string | null = null;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      for (const key of Object.keys(defaultSettings) as (keyof Settings)[]) {
        if (key in parsed && typeof parsed[key] === typeof defaultSettings[key]) {
          (next as Record<string, unknown>)[key] = parsed[key];
        }
      }
    } catch (e) {
      error = `settings.json is not valid JSON: ${e}`;
    }
  }
  // A typo in a theme name must not leave the app without a theme.
  const unknown: string[] = [];
  for (const [key, allowed] of Object.entries(THEME_CHOICES)) {
    const name = key as keyof typeof THEME_CHOICES;
    if (!allowed.includes(next[name])) {
      unknown.push(`${key} "${next[name]}"`);
      (next as Record<string, unknown>)[name] = defaultSettings[name];
    }
  }
  if (unknown.length) error = `${error ? error + " " : ""}Unknown ${unknown.join(", ")}: using the default.`;
  Object.assign(settings, next);
  settingsStatus.error = error;
  return error;
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Changes entries of settings.json (a value of `undefined` removes the entry, which is how a setting returns to its
 * default) and applies the result at once. Everything else in the file stays, including entries Kladde does not know.
 * Writes run one after another, so quick changes cannot overwrite each other. Returns a message if something is
 * wrong; a file that is not valid JSON is never overwritten.
 */
export function updateSettingsFile(changes: Record<string, unknown>): Promise<string | null> {
  const run = writeChain.then(async () => {
    const file = await readConfigObject(SETTINGS_FILE);
    if (!file) return `${SETTINGS_FILE} is not valid JSON. Fix it first (Open settings), then try again.`;
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete file[name];
      else file[name] = value;
    }
    try {
      await writeConfigFile(SETTINGS_FILE, JSON.stringify(file, null, 2) + "\n");
    } catch (e) {
      return `Could not write ${SETTINGS_FILE}: ${e instanceof Error ? e.message : e}`;
    }
    return loadSettings();
  });
  writeChain = run.catch(() => {});
  return run;
}

export function defaultSettingsJson(): string {
  return JSON.stringify(defaultSettings, null, 2) + "\n";
}
