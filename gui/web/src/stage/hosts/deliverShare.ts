import type { ShareOptions } from "../../stages/deliver/shareLogic";
import type { TunnelStatus } from "../../types/tunnel";
import type { ShareFlow } from "./shareFlowContext";

export function shareOptionsOf(
  flow: ShareFlow,
  host: {
    /** Online sharing state; null without the `tunnel.status` feature. */
    tunnel: TunnelStatus | null;
    /** Why Share is unavailable (the command's reason). */
    blockedReason?: string;
    onOpenRecord: () => void;
    focusRequested: boolean;
    onFocused: () => void;
  },
): ShareOptions {
  return {
    rows: flow.rows,
    loaded: flow.loaded,
    choices: flow.choices,
    onChoices: flow.setChoices,
    busy: flow.busy,
    recovery: flow.recovery,
    error: flow.error,
    status: flow.status,
    copiedKey: flow.copiedKey,
    blockedKey: flow.blockedKey,
    tunnel: host.tunnel,
    blockedReason: host.blockedReason,
    onCreate: flow.create,
    onRefreshMix: flow.refreshMix,
    onCopy: flow.copy,
    onStop: flow.stop,
    onCreateRecord: flow.createRecord,
    onReplaceInvite: flow.replaceInvite,
    onEndRoom: flow.endRoom,
    onOpenRecord: host.onOpenRecord,
    focusRequested: host.focusRequested,
    onFocused: host.onFocused,
  };
}
