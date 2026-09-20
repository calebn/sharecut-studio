/**
 * Optional user key remaps (localStorage). Default bindings stay in registry.ts.
 * Empty / missing override → use catalog keys.
 */

import { migrateLocalStorageKey } from "../utils/legacyStorage";

const STORAGE_KEY = "sharecut.keymap.overrides";
const LEGACY_STORAGE_KEY = "dawshell.keymap.overrides";

export type KeymapOverrides = Record<string, string[]>;

let memory: KeymapOverrides | null = null;

function readStorage(): KeymapOverrides {
  if (memory) {
    return memory;
  }
  if (typeof localStorage === "undefined") {
    memory = {};
    return memory;
  }
  try {
    const raw = migrateLocalStorageKey(STORAGE_KEY, LEGACY_STORAGE_KEY);
    memory = raw ? (JSON.parse(raw) as KeymapOverrides) : {};
  } catch {
    memory = {};
  }
  return memory;
}

function writeStorage(next: KeymapOverrides): void {
  memory = next;
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function getKeymapOverride(commandId: string): string[] | undefined {
  const v = readStorage()[commandId];
  return v?.length ? v : undefined;
}

export function setKeymapOverride(commandId: string, keys: string[]): void {
  const next = { ...readStorage(), [commandId]: keys };
  writeStorage(next);
}

export function clearKeymapOverride(commandId: string): void {
  const next = { ...readStorage() };
  delete next[commandId];
  writeStorage(next);
}

export function clearAllKeymapOverrides(): void {
  writeStorage({});
}

/** Test helper — reset in-memory + storage. */
export function _resetKeymapOverridesForTests(): void {
  memory = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    /* jsdom / incomplete localStorage stubs */
  }
}
