import { memo, useCallback } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { usePrepareModel } from "../../stages/prepare/usePrepareModel";
import { useDawStore } from "../../state/dawStore";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { useKeepFocusInView } from "../useKeepFocusInView";
import { useStageScroll } from "../useStageScroll";
import { hostStateOf } from "./hostModels";
import { PrepareStageView } from "./PrepareStageView";

export type PrepareStageProps = {
  loadFailure?: LoadFailure | null;
};

function PrepareStageAdapter({ loadFailure }: PrepareStageProps) {
  const loaded = useDawStore((s) => s.project != null);
  const shell = useViewportClass();
  const saveScroll = useStageScroll("prepare", "body");
  const keepFocusInView = useKeepFocusInView();
  const scrollRef = useCallback(
    (node: HTMLElement | null) => {
      saveScroll(node);
      const stopKeeping = keepFocusInView(node);
      return () => {
        saveScroll(null);
        stopKeeping?.();
      };
    },
    [saveScroll, keepFocusInView],
  );
  const model = usePrepareModel();
  return (
    <PrepareStageView
      shell={shell}
      state={hostStateOf(loaded ? true : null, loadFailure)}
      failure={loadFailure}
      scrollRef={scrollRef}
      view={model.view}
      advanced={model.advanced}
    />
  );
}

/**
 * The Prepare stage host: the stage view, bound to the project and the
 * pipeline job. Host only; the frame never offers it to a guest.
 */
export const PrepareStage = memo(PrepareStageAdapter);
