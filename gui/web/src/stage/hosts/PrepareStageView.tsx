import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { Button } from "../../ui";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import { HostBody } from "./HostBody";
import type { HostState, PrepareHandoff } from "./hostModels";

export type PrepareStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  /** A new project: the two source tiles and nothing else. */
  empty: boolean;
  /** The caller may add audio to this project. */
  canIngest: boolean;
  importShortcut: string | null;
  handoff: PrepareHandoff;
  /** The drop target for an empty project. */
  dropTarget: ReactNode;
  /** Pipeline status and its controls. */
  pipeline: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  onImport: () => void;
  onRecord: () => void;
  onHandoff: () => void;
};

/** Prepare: bring audio in, get it transcribed, hand off to Review or Edit. */
export function PrepareStageView({
  shell,
  state,
  failure,
  empty,
  canIngest,
  importShortcut,
  handoff,
  dropTarget,
  pipeline,
  scrollRef,
  onImport,
  onRecord,
  onHandoff,
}: PrepareStageViewProps) {
  const sources = (
    <section className="stage-host-section" aria-labelledby="prepare-sources">
      <h2 id="prepare-sources" className="stage-host-title">
        Sources
      </h2>
      <div className="stage-host-actions">
        {canIngest ? (
          <Button onClick={onImport}>
            Add audio{importShortcut ? ` (${importShortcut})` : ""}
          </Button>
        ) : null}
        <Button onClick={onRecord}>Record another session</Button>
      </div>
    </section>
  );
  return (
    <HostBody
      stage="prepare"
      shell={shell}
      state={state}
      failure={failure}
      scrollRef={scrollRef}
    >
      {empty ? (
        <div className="stage-host-empty">
          {canIngest ? dropTarget : null}
          {sources}
        </div>
      ) : (
        <div className="stage-host-columns">
          {sources}
          <section
            className="stage-host-section stage-host-section--wide"
            aria-labelledby="prepare-ready"
          >
            <h2 id="prepare-ready" className="stage-host-title">
              Getting ready
            </h2>
            {pipeline}
            <div className="stage-host-handoff">
              <Button
                variant={handoff.primary ? "primary" : "default"}
                onClick={onHandoff}
              >
                {handoff.label}
              </Button>
            </div>
          </section>
        </div>
      )}
    </HostBody>
  );
}
