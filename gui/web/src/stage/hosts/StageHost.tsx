import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf, stagesForRole } from "../../state/stageRoutes";
import { Cover } from "../../system/Cover";
import { stageLabel } from "../../system/verbs";
import { isHostRole } from "../../utils/can";
import { EditWorkspace } from "../edit/EditWorkspace";
import type { ViewAnchorAvailability } from "../edit/useViewAnchor";
import { DeliverStage } from "./DeliverStage";
import { GuestDeliver } from "./GuestDeliver";
import { HostBody } from "./HostBody";
import { type LoadFailure, stageAvailable } from "./hostModels";
import { PrepareStage } from "./PrepareStage";
import { RecordStage } from "./RecordStage";
import { ReviewHost } from "./ReviewHost";

export type StageHostProps = {
  viewAnchor?: ViewAnchorAvailability;
  guestShare?: boolean;
  loadFailure?: LoadFailure | null;
  /** The 4 s Retry of the loading skeleton: the same bootstrap retry as Try again. */
  onRetryLoad?: () => void;
};

function StageHostAdapter({
  viewAnchor,
  guestShare = false,
  loadFailure,
  onRetryLoad,
}: StageHostProps) {
  const { stage, guestMode, loaded, projectPath, projectEpoch } = useDawStore(
    useShallow((s) => ({
      stage: s.stage,
      guestMode: s.guestMode,
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      loaded: s.project != null,
    })),
  );
  const shell = useViewportClass();
  const role = stageRoleOf(guestMode);
  if (!loaded && (guestShare || guestMode != null)) {
    // A link's role is known only with the project, so nothing is judged yet.
    return (
      <HostBody
        stage={stage}
        shell={shell}
        state={loadFailure ? "error" : "loading"}
        failure={loadFailure}
        onRetry={onRetryLoad}
      >
        {null}
      </HostBody>
    );
  }
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
          viewAnchor={viewAnchor}
          guestShare={guestShare}
          loadFailure={loadFailure}
        />
      );
    case "review":
      return (
        <ReviewHost
          key={`${projectPath}:${projectEpoch}`}
          guestShare={guestShare}
          loadFailure={loadFailure}
        />
      );
    case "deliver":
      return isHostRole(role) ? (
        <DeliverStage loadFailure={loadFailure} />
      ) : (
        <GuestDeliver loadFailure={loadFailure} />
      );
  }
}

/**
 * Picks the host for the open stage. Role-gated: a link that cannot open the
 * stage gets a Cover with a way to its first allowed stage, never a control
 * it cannot use. Mounted by the frame as its children at the swap.
 */
export const StageHost = memo(StageHostAdapter);
