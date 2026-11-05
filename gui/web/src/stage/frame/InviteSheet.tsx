import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useHasFeature } from "../../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_MENU,
  FEATURE_TUNNEL_STATUS,
} from "../../extensions/features";
import type { ShareOptions } from "../../stages/deliver/shareLogic";
import { useDawStore } from "../../state/dawStore";
import { Sheet } from "../../system/Sheet";
import type { InviteGroup } from "../../types/stage";
import type { DrawerDetent } from "../../ui/BottomSheet";
import { useCommand } from "../../ui/useCommand";
import { shareOptionsOf } from "../hosts/deliverShare";
import { useShareFlow } from "../hosts/shareFlowContext";
import { useTunnelStatus } from "../hosts/useTunnelStatus";
import { InviteBody } from "./invite/InviteBody";

export const INVITE_TITLE = "Invite";

type ViewProps = {
  options: ShareOptions;
  at?: InviteGroup | null;
  form: "anchored" | "side" | "centered" | "bottom";
  onClose: () => void;
  /** Dialog and bottom forms: whether the sheet is showing. Open by default. */
  open?: boolean;
  detent?: DrawerDetent | "fit";
  onDetentChange?: (detent: DrawerDetent) => void;
};

/** The Invite sheet: Link rows grouped Review links, Record links and Listen link. */
export function InviteSheetView({
  options,
  at,
  form,
  onClose,
  open,
  detent,
  onDetentChange,
}: ViewProps) {
  return (
    <Sheet
      form={form}
      open={open}
      title={INVITE_TITLE}
      icon="user-plus"
      detent={detent}
      onDetentChange={onDetentChange}
      onClose={onClose}
    >
      <InviteBody options={options} at={at} />
    </Sheet>
  );
}

/** The Invite sheet on the host's links: lists them as it opens. */
export function InviteSheet({
  form,
  onClose,
  detent,
  onDetentChange,
}: Pick<ViewProps, "form" | "onClose" | "detent" | "onDetentChange">) {
  const flow = useShareFlow();
  const reload = flow.reload;
  const { at, projectPath } = useDawStore(
    useShallow((s) => ({ at: s.inviteAt, projectPath: s.projectPath })),
  );
  const tunnelFeature = useHasFeature(FEATURE_TUNNEL_STATUS);
  const shareOffered = useHasFeature(FEATURE_SHARE_UI_MENU);
  const tunnel = useTunnelStatus(tunnelFeature && shareOffered);
  const shareCmd = useCommand("share.manage");
  useEffect(() => {
    if (projectPath) reload();
  }, [projectPath, reload]);
  return (
    <InviteSheetView
      options={shareOptionsOf(flow, {
        tunnel,
        blockedReason: shareCmd.whenReason,
        onOpenRecord: undefined,
      })}
      at={at}
      form={form}
      onClose={onClose}
      detent={detent}
      onDetentChange={onDetentChange}
    />
  );
}
