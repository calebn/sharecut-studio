import type { ShareOptions } from "../../stages/deliver/shareLogic";
import type { ShareFlow } from "./shareFlowContext";

export function shareOptionsOf(
  flow: ShareFlow,
  host: {
    /** Why sharing is unavailable (the command's reason). */
    blockedReason?: string;
    onOpenRecord?: () => void;
  },
): ShareOptions {
  return {
    rows: flow.rows,
    loaded: flow.loaded,
    listFailed: flow.listFailed,
    choices: flow.choices,
    onChoices: flow.setChoices,
    busy: flow.busy,
    recovery: flow.recovery,
    refreshFor: flow.refreshFor,
    error: flow.error,
    status: flow.status,
    copiedKey: flow.copiedKey,
    blockedKey: flow.blockedKey,
    tunnel: flow.tunnel,
    blockedReason: host.blockedReason,
    onCreate: flow.create,
    onRefreshMix: flow.refreshMix,
    onCopy: flow.copy,
    onStop: flow.stop,
    onCreateRecord: flow.createRecord,
    onReplaceInvite: flow.replaceInvite,
    onEndRoom: flow.endRoom,
    onOpenRecord: host.onOpenRecord,
  };
}
