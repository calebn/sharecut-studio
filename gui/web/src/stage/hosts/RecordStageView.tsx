import type { ReactNode, Ref } from "react";
import { Button } from "../../ui";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { HostBody } from "./HostBody";
import type { HostShell, HostState, RecordStatus } from "./hostModels";

export type RecordStageViewProps = {
  shell: HostShell;
  state: HostState;
  failure?: LoadFailure | null;
  status: RecordStatus;
  /** The live clock while a take runs. */
  indicator?: ReactNode;
  /** Why the room cannot be opened now. */
  disabledReason?: string;
  scrollRef?: Ref<HTMLDivElement>;
  onOpenRoom: () => void;
};

/**
 * Record: a launcher with the room's status. The room dialog stays mounted in
 * `DawApp`, so a take keeps running while another stage is up.
 */
export function RecordStageView({
  shell,
  state,
  failure,
  status,
  indicator,
  disabledReason,
  scrollRef,
  onOpenRoom,
}: RecordStageViewProps) {
  return (
    <HostBody
      stage="record"
      shell={shell}
      state={state}
      failure={failure}
      scrollRef={scrollRef}
    >
      <section
        className="stage-host-section stage-host-launcher"
        aria-labelledby="record-room"
        data-record-state={status.kind}
      >
        <h2 id="record-room" className="stage-host-title">
          {status.title}
        </h2>
        {indicator}
        <p className="stage-host-note" role="status">
          {status.detail}
        </p>
        <div className="stage-host-actions">
          <Button
            variant="primary"
            disabledReason={disabledReason}
            onClick={onOpenRoom}
          >
            {status.kind === "idle" ? "Open the room" : "Back to the room"}
          </Button>
        </div>
      </section>
    </HostBody>
  );
}
