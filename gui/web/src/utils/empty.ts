import type { ClipRow } from "../types/project";

/**
 * Shared empty containers. A fresh `[]` / `{}` / `new Set()` fallback is a
 * new reference every render, which defeats `memo` and `useShallow`; these
 * never change, so a prop that falls back to one stays equal.
 */
export const EMPTY_ARR: readonly never[] = Object.freeze([]);

export const EMPTY_CLIPS: readonly ClipRow[] = EMPTY_ARR;

export const EMPTY_SET: ReadonlySet<never> = Object.freeze(new Set<never>());

export const EMPTY_OBJ: Readonly<Record<string, never>> = Object.freeze({});
