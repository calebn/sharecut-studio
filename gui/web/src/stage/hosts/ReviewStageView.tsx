import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { StageHandoff } from "../../system/StageHandoff";
import { HostBody } from "./HostBody";
import type { HostState, LoadFailure } from "./hostModels";

export type ReviewStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  /** The Queue panel. */
  panel: ReactNode;
  /** Offered to the host; secondary while anything waits on a decision. */
  onDeliver?: () => void;
  /** Items still waiting on a decision; zero makes the hand-off primary. */
  undecided?: number;
  scrollRef?: Ref<HTMLDivElement>;
};

/**
 * Review: the Queue, for every role. A load failure is not this body's:
 * the panel puts the failure Cover in the transcript or queue region and the
 * rest stays usable.
 */
export function ReviewStageView({
  shell,
  state,
  failure,
  panel,
  onDeliver,
  undecided = 0,
  scrollRef,
}: ReviewStageViewProps) {
  return (
    <HostBody
      stage="review"
      shell={shell}
      state={state === "error" ? "ready" : state}
      failure={failure}
    >
      <div
        ref={scrollRef}
        className="stage-host-panel"
        role="region"
        aria-label="Queue"
      >
        {panel}
      </div>
      {onDeliver ? (
        <div className="stage-host-handoff">
          <StageHandoff
            stage="deliver"
            label="Deliver"
            variant={undecided === 0 ? "primary" : "secondary"}
            size={shell === "phone" ? 48 : 40}
            keyHint={false}
            onActivate={onDeliver}
          />
        </div>
      ) : null}
    </HostBody>
  );
}
