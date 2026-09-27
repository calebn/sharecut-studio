/**
 * Optional user key remaps (localStorage). Default bindings stay in registry.ts.
 * Empty / missing override → use catalog keys.
 */

import { readLocal, writeLocal } from "../utils/storage";

const STORAGE_KEY = "sharecut.keymap.overrides";

export type KeymapOverrides = Record<string, string[]>;

let memory: KeymapOverrides | null = null;

/** Remaps saved under renamed command ids (#525: focus.* became layout.*); null = removed. */
const RENAMED_COMMANDS: Readonly<Record<string, string | null>> = {
  "focus.default": "layout.default",
  "focus.timeline": "layout.timeline",
  "focus.text": "layout.text",
  "focus.review": "layout.review",
  "focus.cycle": null,
};

/** Move renamed ids to their new id (an existing remap there wins); drop removed ones. */
function migrateRenamed(saved: KeymapOverrides): KeymapOverrides | null {
  let next: KeymapOverrides | null = null;
  for (const [oldId, newId] of Object.entries(RENAMED_COMMANDS)) {
    const keys = saved[oldId];
    if (keys === undefined) {
      continue;
    }
    next ??= { ...saved };
    delete next[oldId];
    if (newId && next[newId] === undefined) {
      next[newId] = keys;
    }
  }
  return next;
}

function readStorage(): KeymapOverrides {
  if (memory) {
    return memory;
  }
  const raw = readLocal(STORAGE_KEY);
  let saved: KeymapOverrides;
  try {
    saved = raw ? (JSON.parse(raw) as KeymapOverrides) : {};
  } catch {
    saved = {};
  }
  const migrated = migrateRenamed(saved);
  if (migrated) {
    writeStorage(migrated);
    return migrated;
  }
  memory = saved;
  return saved;
}

function writeStorage(next: KeymapOverrides): void {
  memory = next;
  writeLocal(STORAGE_KEY, JSON.stringify(next));
}

/**
 * A remap replaces the command's key only; its Mod/Shift requirements stay
 * (the matcher applies them). Typed combos like "Mod+Shift+X" keep their last
 * segment, so display and matching agree.
 */
export function normalizeRemapKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "+" || !trimmed.includes("+")) {
    return trimmed;
  }
  return trimmed.split("+").pop()?.trim() ?? "";
}

export function getKeymapOverride(commandId: string): string[] | undefined {
  const keys = (readStorage()[commandId] ?? [])
    .map(normalizeRemapKey)
    .filter(Boolean);
  return keys.length ? keys : undefined;
}

export function setKeymapOverride(commandId: string, keys: string[]): void {
  const normalized = keys.map(normalizeRemapKey).filter(Boolean);
  const next = { ...readStorage(), [commandId]: normalized };
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
    }
  } catch {
    /* jsdom / incomplete localStorage stubs */
  }
}
