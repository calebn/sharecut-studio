import { readLocal, writeLocal } from "../../utils/storage";

const KEY = "sharecut.palette.recent.v1";
const KEPT = 12;

/** Ids of the last commands and entries run from the palette, newest first; per browser. */
export function readPaletteRecent(): string[] {
  const raw = readLocal(KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [
          ...new Set(parsed.filter((v): v is string => typeof v === "string")),
        ].slice(0, KEPT)
      : [];
  } catch {
    return [];
  }
}

/** Puts `id` first, drops its older entry, and returns the new list. */
export function rememberPaletteRecent(id: string): string[] {
  const next = [id, ...readPaletteRecent().filter((v) => v !== id)].slice(
    0,
    KEPT,
  );
  writeLocal(KEY, JSON.stringify(next));
  return next;
}
