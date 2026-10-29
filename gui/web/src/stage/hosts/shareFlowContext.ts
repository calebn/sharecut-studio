import { createContext, useContext } from "react";
import type {
  ShareChoices,
  ShareCopiedKey,
  ShareCopyKind,
  ShareCreateRecovery,
} from "../../stages/deliver/shareLogic";
import type { HostShareRow } from "../../types/shares";

export type ShareFlow = {
  /** Every host share row of the open project, as last listed. */
  rows: readonly HostShareRow[];
  /** False until the first list of this project answers. */
  loaded: boolean;
  choices: ShareChoices;
  setChoices: (next: ShareChoices) => void;
  /** One action runs at a time; a second is dropped while this is true. */
  busy: boolean;
  recovery: ShareCreateRecovery;
  error: string | null;
  status: string | null;
  copiedKey: ShareCopiedKey | null;
  blockedKey: ShareCopiedKey | null;
  /** Lists the project's links again. Deliver calls it as it shows. */
  reload: () => void;
  /** Makes the link the choices say and copies it. Call it from the click so the copy keeps its user gesture. */
  create: () => void;
  /** Refreshes the mix after a refused create, then makes one more create with the choices now shown. */
  refreshMix: () => void;
  copy: (
    kind: ShareCopyKind,
    token: string,
    label: string,
    text: string | null,
  ) => void;
  stop: (token: string) => void;
  createRecord: () => void;
  replaceInvite: (sourceToken: string) => void;
  endRoom: (sessionId: string) => void;
};

export const Flow = createContext<ShareFlow | null>(null);

export function useShareFlow(): ShareFlow {
  const flow = useContext(Flow);
  if (!flow) {
    throw new Error("useShareFlow needs a ShareFlowProvider above it.");
  }
  return flow;
}
