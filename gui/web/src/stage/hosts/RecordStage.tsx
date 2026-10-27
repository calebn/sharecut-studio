import { memo } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useViewportClass } from "../../hooks/useViewportClass";
import {
  isRecordTransportVisible,
  liveTakeOpen,
  RecIndicator,
  useRecordHostStore,
} from "../../record";
import { useDawStore } from "../../state/dawStore";
import { useCommand } from "../../ui/useCommand";
import type { LoadFailure } from "../frame/LoadFailureBanner";

import { hostStateOf, recordStatusOf } from "./hostModels";
import { RecordStageView } from "./RecordStageView";

export type RecordStageProps = {
  loadFailure?: LoadFailure | null;
};

function RecordStageAdapter({ loadFailure }: RecordStageProps) {
  const project = useDawStore((s) => s.project);
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const dropped = useRecordHostStore((s) => s.dropped);
  const open = useCommand("record.openPanel");
  const shell = useViewportClass();
  const live = liveTakeOpen(snapshot?.state);
  return (
    <RecordStageView
      shell={shell}
      state={hostStateOf(project, loadFailure)}
      failure={loadFailure}
      status={recordStatusOf(snapshot)}
      indicator={
        isRecordTransportVisible(snapshot) ? (
          <RecIndicator
            snapshot={snapshot}
            capture={captureHealth}
            offline={dropped && live}
          />
        ) : undefined
      }
      disabledReason={open.whenReason}
      onOpenRoom={() => runPointerCommand("record.openPanel")}
    />
  );
}

/**
 * The Record stage host: a launcher with the live-take status. The Record
 * dialog stays mounted in `DawApp`, so a take survives stage switches; the
 * frame hides the Player here.
 */
export const RecordStage = memo(RecordStageAdapter);
