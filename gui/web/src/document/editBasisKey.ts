import type { ProjectView } from "../types/project";
import { sameBasis } from "../utils/projectBasis";
import { documentAuthority } from "./authorityState";

type Cached = {
  basis: ProjectView;
  seq: number;
  token: string | null;
  key: string;
};
let last: Cached | null = null;

export function editBasisKey(basis: ProjectView | null): string {
  if (!basis) return "";
  const { seq, token } = documentAuthority;
  if (last && last.seq === seq && last.token === token) {
    if (sameBasis(last.basis, basis)) {
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
