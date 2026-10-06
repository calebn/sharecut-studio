/**
 * Labs: prototype behaviour an owner opts into per browser, off by default.
 * View › Labs toggles a flag, and `?lab=<slug>` (or `?lab=-<slug>` to turn it
 * off) sets it from a link, so a phone can join a test without the menu. The
 * choice persists in `localStorage`; it is a convenience, not project state.
 */
import { useSyncExternalStore } from "react";
import { readLocal, writeLocal } from "./storage";

export const LAB_FLAGS = {
  touchChooser: {
    slug: "touch-chooser",
    label: "Touch target chooser",
  },
} as const;

export type LabFlag = keyof typeof LAB_FLAGS;

export const LAB_STORAGE_KEY = "sharecut.labs";
export const LAB_QUERY_PARAM = "lab";

const listeners = new Set<() => void>();

function readEnabled(): Set<LabFlag> {
  const raw = readLocal(LAB_STORAGE_KEY);
  const enabled = new Set<LabFlag>();
  for (const name of raw?.split(",") ?? []) {
    if (Object.hasOwn(LAB_FLAGS, name)) enabled.add(name as LabFlag);
  }
  return enabled;
}

let enabled = readEnabled();

export function isLabEnabled(flag: LabFlag): boolean {
  return enabled.has(flag);
}

export function setLabEnabled(flag: LabFlag, on: boolean): void {
  if (enabled.has(flag) === on) return;
  enabled = new Set(enabled);
  if (on) enabled.add(flag);
  else enabled.delete(flag);
  writeLocal(LAB_STORAGE_KEY, [...enabled].join(","));
  for (const listener of listeners) listener();
}

/** Applies every `?lab=` value in `search`; unknown slugs are ignored. */
export function applyLabQuery(search: string): void {
  for (const value of new URLSearchParams(search).getAll(LAB_QUERY_PARAM)) {
    const off = value.startsWith("-");
    const slug = off ? value.slice(1) : value;
    for (const [flag, def] of Object.entries(LAB_FLAGS)) {
      if (def.slug === slug) setLabEnabled(flag as LabFlag, !off);
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLabFlag(flag: LabFlag): boolean {
  return useSyncExternalStore(subscribe, () => enabled.has(flag));
}
