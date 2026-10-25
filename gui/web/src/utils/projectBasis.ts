import type { ProjectView } from "../types/project";

export const LATE = {
  root: ["transcript", "meta", "history"],
  meta: ["hydration"],
  history: ["groups"],
} as const;

function sameShallow(a: object, b: object, skip: readonly string[]): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keep = (name: string) => !skip.includes(name);
  const keys = Object.keys(ra).filter(keep);
  return (
    keys.length === Object.keys(rb).filter(keep).length &&
    keys.every((name) => Object.is(ra[name], rb[name]))
  );
}

function sameRoot(a: ProjectView, b: ProjectView): boolean {
  return (
    sameShallow(a, b, LATE.root) &&
    sameShallow(a.meta, b.meta, LATE.meta) &&
    sameShallow(a.history, b.history, LATE.history)
  );
}

export function sameBasis(
  a: ProjectView | null,
  b: ProjectView | null,
): boolean {
  return a === b || (!!a && !!b && sameRoot(a, b));
}
