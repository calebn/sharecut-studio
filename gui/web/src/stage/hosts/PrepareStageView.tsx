import type { Ref } from "react";
import {
  AdvancedSteps,
  type AdvancedStepsProps,
} from "../../stages/prepare/AdvancedSteps";
import {
  PrepareView,
  type PrepareViewProps,
} from "../../stages/prepare/PrepareView";
import type { ShellBreakpoint } from "../../state/types";
import { Sheet } from "../../system/Sheet";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { HostBody } from "./HostBody";
import type { HostState } from "./hostModels";

export type PrepareStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  scrollRef?: Ref<HTMLDivElement>;
  view: PrepareViewProps;
  advanced: {
    open: boolean;
    onClose: () => void;
    props: AdvancedStepsProps;
  };
};

/** Prepare: the stage view inside the host's scroller, with the Advanced steps sheet. */
export function PrepareStageView({
  shell,
  state,
  failure,
  scrollRef,
  view,
  advanced,
}: PrepareStageViewProps) {
  return (
    <HostBody
      stage="prepare"
      shell={shell}
      state={state}
      failure={failure}
      scrollRef={scrollRef}
    >
      <PrepareView {...view} />
      <Sheet
        form={shell === "phone" ? "bottom" : "centered"}
        title="Advanced steps"
        open={advanced.open}
        onClose={advanced.onClose}
      >
        <AdvancedSteps {...advanced.props} />
      </Sheet>
    </HostBody>
  );
}
