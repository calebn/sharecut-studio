import { useDaw } from "../../state/useDaw";
import { useShareFlow } from "../hosts/shareFlow";
import { ShareDialogView } from "./ShareDialogView";

export function ShareDialog() {
  const { shareDialogOpen, setShareDialogOpen, project } = useDaw((s) => ({
    shareDialogOpen: s.chrome.shareDialogOpen,
    setShareDialogOpen: s.setShareDialogOpen,
    project: s.project,
  }));
  const flow = useShareFlow(shareDialogOpen);
  return (
    <ShareDialogView
      open={shareDialogOpen && !!project}
      onClose={() => setShareDialogOpen(false)}
      role={flow.role}
      onRoleChange={flow.setRole}
      withMcp={flow.withMcp}
      onWithMcpChange={flow.setWithMcp}
      freeze={flow.freeze}
      onFreezeChange={flow.setFreeze}
      rows={flow.rows}
      busy={flow.busy}
      createRecovery={flow.createRecovery}
      error={flow.error}
      status={flow.status}
      copiedKey={flow.copiedKey}
      lastCreated={flow.lastCreated}
      tunnel={flow.tunnel}
      onCreate={flow.create}
      onRefreshMix={flow.refreshMix}
      onCreateRecord={flow.createRecord}
      onCopy={flow.copy}
      onRevoke={flow.revoke}
      onEndRoom={flow.endRoom}
      onReplaceRecordInvite={flow.replaceRecordInvite}
      onOpenRoomPanel={() => {
        setShareDialogOpen(false);
        flow.openRoomPanel();
      }}
    />
  );
}
