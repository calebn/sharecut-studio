/**
 * The precision drag lab (#1184): with Auto on, arming a target decides by
 * itself whether the drag goes into precision (`precisionDecision.ts`), and
 * Style picks what precision looks like. Off leaves every armed drag as the
 * touch grammar has it.
 *
 * `?lab=precision:auto` turns Auto on, `?lab=precision:jog` (or `lens`,
 * `grip`) picks the style and turns Auto on, and `?lab=-precision` or
 * `?lab=precision:off` turns it off; View › Labs does the same on the phone.
 * Auto rides on the touch grammar's long-press arm, which is always on. Per
 * browser, saved in `localStorage`, and off until chosen; a convenience, not
 * project state.
 */
import { useSyncExternalStore } from "react";
import { readLocal, writeLocal } from "../../utils/storage";

export const PRECISION_STYLES = {
  jog: { label: "Jog pad" },
  lens: { label: "Auto-zoom lens" },
  grip: { label: "Offset grip" },
} as const;

export type PrecisionStyle = keyof typeof PRECISION_STYLES;

export interface PrecisionLab {
  auto: boolean;
  style: PrecisionStyle;
}

export const PRECISION_STORAGE_KEY = "sharecut.labs.precision";
export const PRECISION_STYLE_KEY = "sharecut.labs.precision.style";
const SLUG = "precision";
const LAB_QUERY_PARAM = "lab";

function isStyle(value: string | null | undefined): value is PrecisionStyle {
  return value != null && Object.hasOwn(PRECISION_STYLES, value);
}

let current: PrecisionLab = {
  auto: readLocal(PRECISION_STORAGE_KEY) === "auto",
  style: (() => {
    const saved = readLocal(PRECISION_STYLE_KEY);
    return isStyle(saved) ? saved : "jog";
  })(),
};
const listeners = new Set<() => void>();

export function precisionLab(): PrecisionLab {
  return current;
}

function update(next: PrecisionLab) {
  if (next.auto === current.auto && next.style === current.style) return;
  current = next;
  writeLocal(PRECISION_STORAGE_KEY, next.auto ? "auto" : "");
  writeLocal(PRECISION_STYLE_KEY, next.style);
  for (const listener of listeners) listener();
}

export function setPrecisionAuto(auto: boolean): void {
  update({ ...current, auto });
}

export function setPrecisionStyle(style: PrecisionStyle): void {
  update({ ...current, style });
}

/** Applies every `?lab=precision:…` and `?lab=-precision` in `search`. */
export function applyPrecisionQuery(search: string): void {
  for (const value of new URLSearchParams(search).getAll(LAB_QUERY_PARAM)) {
    if (value === `-${SLUG}` || value === `${SLUG}:off`) {
      setPrecisionAuto(false);
      continue;
    }
    const [slug, choice] = value.split(":");
    if (slug !== SLUG) continue;
    if (choice === "auto") setPrecisionAuto(true);
    else if (isStyle(choice)) update({ auto: true, style: choice });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePrecisionLab(): PrecisionLab {
  return useSyncExternalStore(subscribe, () => current);
}
