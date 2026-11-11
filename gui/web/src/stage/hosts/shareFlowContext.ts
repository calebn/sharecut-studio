import { createContext, useContext } from "react";
import type {
  ShareChoices,
  ShareCopiedKey,
  ShareCopyKind,
  ShareCreateRecovery,
} from "../../stages/deliver/shareLogic";
import type { HostShareRow } from "../../types/shares";
import type { TunnelStatus } from "../../types/tunnel";

export type ShareFlow = {
  /** Every host share row of the open project, as last listed. */
  rows: readonly HostShareRow[];
  /** False until the first list of this project answers. */
  loaded: boolean;
  /** True while the last list failed, until a list answers. */
  listFailed: boolean;
  choices: ShareChoices;
  setChoices: (next: ShareChoices) => void;
  /** One action runs at a time; a second is dropped while this is true. */
  busy: boolean;
  recovery: ShareCreateRecovery;
  /** The choices of the create that needs Refresh mix: the row that asked shows "Make a mix to share". */
  refreshFor: { choices: ShareChoices; listen: boolean } | null;
  error: string | null;
  status: string | null;
  copiedKey: ShareCopiedKey | null;
  blockedKey: ShareCopiedKey | null;
  /** Online sharing state, polled while Deliver or the Invite sheet shows; null without the `tunnel.status` feature or when unreachable. */
  tunnel: TunnelStatus | null;
  /** Lists the project's links again. The flow calls it as Deliver or the Invite sheet shows. */
  reload: () => void;
  /** Makes the link the choices say (or `override`, for the listen link) and copies it. Call it from the click so the copy keeps its user gesture. */
  create: (override?: ShareChoices) => void;
  /** Refreshes the mix after a refused create, then makes one more create with the choices now shown. */
  refreshMix: () => void;
  copy: (
    kind: ShareCopyKind,
    token: string,
    label: string,
    text: string | null,
  ) => void;
  stop: (token: string, focus?: () => HTMLElement | null) => boolean;
  createRecord: () => void;
  replaceInvite: (sourceToken: string) => void;
  endRoom: (sessionId: string, focus?: () => HTMLElement | null) => boolean;
};

export const Flow = createContext<ShareFlow | null>(null);

export function useShareFlow(): ShareFlow {
  const flow = useContext(Flow);
  if (!flow) {
    throw new Error("useShareFlow needs a ShareFlowProvider above it.");
  }
  return flow;
}
