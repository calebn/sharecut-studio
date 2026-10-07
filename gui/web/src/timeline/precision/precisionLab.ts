/**
 * The precision-drag bake-off lab (#1184): which of three prototype ways to
 * move an armed timeline target precisely is on, if any. `?lab=precision:jog`
 * (or `lens`, `grip`) picks one from a link and `?lab=-precision` turns it
 * off; View › Labs switches between them on the phone. A variant rides on the
 * touch grammar's long-press arm, which is always on. Per browser, saved in
 * `localStorage`; a convenience, not project state.
 */
import { useSyncExternalStore } from "react";
import { readLocal, writeLocal } from "../../utils/storage";

export const PRECISION_VARIANTS = {
  jog: { label: "Jog pad", short: "Jog" },
  lens: { label: "Auto-zoom lens", short: "Lens" },
  grip: { label: "Offset grip", short: "Grip" },
} as const;

export type PrecisionVariant = keyof typeof PRECISION_VARIANTS;

export const PRECISION_STORAGE_KEY = "sharecut.labs.precision";
const SLUG = "precision";
const LAB_QUERY_PARAM = "lab";

function isVariant(value: string | null): value is PrecisionVariant {
  return value != null && Object.hasOwn(PRECISION_VARIANTS, value);
}

let current: PrecisionVariant | null = (() => {
  const saved = readLocal(PRECISION_STORAGE_KEY);
  return isVariant(saved) ? saved : null;
})();
const listeners = new Set<() => void>();

export function precisionVariant(): PrecisionVariant | null {
  return current;
}

export function setPrecisionVariant(variant: PrecisionVariant | null): void {
  if (current === variant) return;
  current = variant;
  writeLocal(PRECISION_STORAGE_KEY, variant ?? "");
  for (const listener of listeners) listener();
}

/** Applies `?lab=precision:<variant>` and `?lab=-precision` in `search`. */
export function applyPrecisionQuery(search: string): void {
  for (const value of new URLSearchParams(search).getAll(LAB_QUERY_PARAM)) {
    if (value === `-${SLUG}`) setPrecisionVariant(null);
    const [slug, variant] = value.split(":");
    if (slug === SLUG && isVariant(variant)) setPrecisionVariant(variant);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrecisionVariant(): PrecisionVariant | null {
  return useSyncExternalStore(subscribe, () => current);
}
