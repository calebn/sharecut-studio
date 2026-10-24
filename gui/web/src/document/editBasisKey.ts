import type { ProjectView } from "../types/project";
import { documentAuthority } from "./authorityState";

type Cached = {
  basis: ProjectView;
  seq: number;
  token: string | null;
  key: string;
};
let last: Cached | null = null;

function sameRoot(a: ProjectView, b: ProjectView): boolean {
  const keys = Object.keys(a) as (keyof ProjectView)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((name) =>
      name === "transcript"
        ? true
        : name === "meta"
          ? a.meta.name === b.meta.name &&
            a.meta.workspace_dir === b.meta.workspace_dir
          : Object.is(a[name], b[name]),
    )
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
  const { transcript: _transcript, meta, ...rest } = basis;
  const { hydration: _hydration, ...stableMeta } = meta;
  const key = JSON.stringify([seq, token, stableMeta, rest]);
  last = { basis, seq, token, key };
  return key;
}
