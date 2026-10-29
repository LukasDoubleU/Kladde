// Reading and writing the JSON files in the config folder (settings.json, keybindings.json) for the
// features that edit them for the user: the shortcut editor and the settings page.
import { api } from "./api";

export type Json = Record<string, unknown>;

/** Reads a config file as a JSON object; null if it is not valid (it must never be overwritten then). */
export async function readConfigObject(name: string): Promise<Json | null> {
  const text = await api.configRead(name);
  if (!text?.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

export async function writeConfigFile(name: string, text: string) {
  const path = await api.configFile(name, "{\n}\n");
  await api.writeFile(path, text, "UTF-8", false, "LF");
}
