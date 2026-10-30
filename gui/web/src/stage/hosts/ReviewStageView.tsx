import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { Button } from "../../ui";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { HostBody } from "./HostBody";
import type { HostState } from "./hostModels";

export type ReviewStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  /** The Queue panel. */
  panel: ReactNode;
  /** Offered to the host once review is done. */
  onDeliver?: () => void;
  scrollRef?: Ref<HTMLDivElement>;
};

/** Review: the Queue, for every role. */
export function ReviewStageView({
  shell,
  state,
  failure,
  panel,
  onDeliver,
  scrollRef,
}: ReviewStageViewProps) {
  return (
    <HostBody stage="review" shell={shell} state={state} failure={failure}>
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
          <Button onClick={onDeliver}>Deliver</Button>
        </div>
      ) : null}
    </HostBody>
  );
}
