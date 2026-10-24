import type { ProjectView } from "../types/project";
import { documentAuthority } from "./authorityState";

type Cached = {
  basis: ProjectView;
  seq: number;
  token: string | null;
  key: string;
};
let last: Cached | null = null;

const LATE = {
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

export function editBasisKey(basis: ProjectView | null): string {
  if (!basis) return "";
  const { seq, token } = documentAuthority;
  if (last && last.seq === seq && last.token === token) {
    if (last.basis === basis || sameRoot(last.basis, basis)) {
      last = { ...last, basis };
      return last.key;
    }
  }
  const { transcript: _transcript, meta, history, ...rest } = basis;
  const { hydration: _hydration, ...stableMeta } = meta;
  const { groups: _groups, ...stableHistory } = history;
  const key = JSON.stringify([seq, token, stableMeta, stableHistory, rest]);
  last = { basis, seq, token, key };
  return key;
}
