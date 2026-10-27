import { memo, type RefCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf, stagesForRole } from "../../state/stageRoutes";
import { Cover } from "../../system/Cover";
import { stageLabel } from "../../system/verbs";
import { EditWorkspace } from "../edit/EditWorkspace";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { DeliverStage } from "./DeliverStage";
import { stageAvailable } from "./hostModels";
import { PrepareStage } from "./PrepareStage";
import { RecordStage } from "./RecordStage";
import { ReviewStage } from "./ReviewStage";

export type StageHostProps = {
  guestShare?: boolean;
  feedbackHostRef?: RefCallback<HTMLDivElement>;
  loadFailure?: LoadFailure | null;
};

function StageHostAdapter({
  guestShare = false,
  feedbackHostRef,
  loadFailure,
}: StageHostProps) {
  const { stage, guestMode } = useDawStore(
    useShallow((s) => ({ stage: s.stage, guestMode: s.guestMode })),
  );
  const role = stageRoleOf(guestMode);
  if (!stageAvailable(stage, role)) {
    // A deep link or a stale stage names something this link cannot open.
    const first = stagesForRole(role)[0];
    return (
      <Cover
        size="region"
        glyph="triangle-alert"
        title="This link can't open that"
        primary={{
          label: `Go to ${stageLabel(first)}`,
          onClick: () => runPointerCommand(`stage.${first}`),
        }}
      >
        Your link doesn't include this part of the project.
      </Cover>
    );
  }
  switch (stage) {
    case "record":
      return <RecordStage loadFailure={loadFailure} />;
    case "prepare":
      return <PrepareStage loadFailure={loadFailure} />;
    case "edit":
      return (
        <EditWorkspace
          guestShare={guestShare}
          feedbackHostRef={feedbackHostRef}
          loadFailure={loadFailure}
        />
      );
    case "review":
      return <ReviewStage guestShare={guestShare} loadFailure={loadFailure} />;
    case "deliver":
      return <DeliverStage loadFailure={loadFailure} />;
  }
}

/**
 * Picks the host for the open stage. Role-gated: a link that cannot open the
 * stage gets a Cover with a way to its first allowed stage, never a control
 * it cannot use. Mounted by the frame as its children at the swap.
 */
export const StageHost = memo(StageHostAdapter);
