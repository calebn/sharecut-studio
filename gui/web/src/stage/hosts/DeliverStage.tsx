import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { FEATURE_SHARE_UI_MENU } from "../../extensions/features";
import { Slot } from "../../extensions/Slot";
import { useStaleRenderBreakdown } from "../../hooks/useStaleRenderBreakdown";
import { useViewportClass } from "../../hooks/useViewportClass";
import { canRefreshMix } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useStageScroll } from "../useStageScroll";
import { DeliverStageView } from "./DeliverStageView";

import { deliverReadiness, hostStateOf, type ReadinessRow } from "./hostModels";

export type DeliverStageProps = {
  loadFailure?: LoadFailure | null;
};

function DeliverStageAdapter({ loadFailure }: DeliverStageProps) {
  const { project, projectPath, guestMode, shareCapabilities } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    })),
  );
  const shell = useViewportClass();
  const scrollRef = useStageScroll("deliver", "body");
  const breakdown = useStaleRenderBreakdown(project);
  const exportCmd = useCommand("export.deliverables");
  const bounceCmd = useCommand("export.bounce");
  const shareCmd = useCommand("share.manage");
  const { rows, summary } = deliverReadiness({
    pendingReviewCount: project?.edit_impact.pending_review_count ?? 0,
    openCommentCount: project?.comments?.filter((c) => !c.resolved).length ?? 0,
    mixStale: project != null && breakdown.stale,
    mixMissing: project != null && breakdown.premixMissing,
    mayRefreshMix: canRefreshMix(projectPath, guestMode, shareCapabilities),
  });

  const onFix = (row: ReadinessRow) => {
    const fix = row.fix;
    if (!fix) return;
    if (fix.kind === "refreshMix") {
      runPointerCommand("render.refreshMix");
    } else {
      runPointerCommand(
        `stage.${fix.stage}`,
        fix.section ? { section: fix.section } : {},
      );
    }
  };
  const action = (
    label: string,
    command: ReturnType<typeof useCommand>,
    id: string,
  ) => ({
    label,
    disabledReason: command.whenReason,
    onClick: () => runPointerCommand(id),
  });
  return (
    <DeliverStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      summary={summary}
      rows={rows}
      onFix={onFix}
      exportAction={action("Export", exportCmd, "export.deliverables")}
      bounce={action("Bounce…", bounceCmd, "export.bounce")}
      share={action("Share a listen link", shareCmd, "share.manage")}
      shareSlot={(content) => <Slot id={FEATURE_SHARE_UI_MENU}>{content}</Slot>}
      scrollRef={scrollRef}
    />
  );
}

/**
 * The Deliver stage host: readiness, then entry points to the Export, Bounce
 * and Share dialogs, which stay mounted in `DawApp`. Host only.
 */
export const DeliverStage = memo(DeliverStageAdapter);
