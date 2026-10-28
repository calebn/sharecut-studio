import {
  type ShareOptions,
  shareReachOf,
} from "../../stages/deliver/shareLogic";
import type { ShareFlow } from "./shareFlow";

/** What the Deliver stage shows for Share, from the flow and the Share request. */
export function shareOptionsOf(
  flow: ShareFlow,
  request: { focusRequested: boolean; onFocused: () => void },
): ShareOptions {
  return {
    role: flow.role,
    onRole: flow.setRole,
    withMcp: flow.withMcp,
    onWithMcp: flow.setWithMcp,
    freeze: flow.freeze,
    onFreeze: flow.setFreeze,
    rows: flow.rows,
    busy: flow.busy,
    createRecovery: flow.createRecovery,
    error: flow.error,
    status: flow.status,
    copiedKey: flow.copiedKey,
    lastCreated: flow.lastCreated,
    tunnel: flow.tunnel,
    reach: shareReachOf(flow.tunnel),
    onCreate: flow.create,
    onRefreshMix: flow.refreshMix,
    onCreateRecord: flow.createRecord,
    onCopy: flow.copy,
    onRevoke: flow.revoke,
    onEndRoom: flow.endRoom,
    onReplaceRecordInvite: flow.replaceRecordInvite,
    onOpenRoomPanel: flow.openRoomPanel,
    focusRequested: request.focusRequested,
    onFocused: request.onFocused,
  };
}
