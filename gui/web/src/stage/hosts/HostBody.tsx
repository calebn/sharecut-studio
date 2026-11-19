import type { ReactNode, Ref } from "react";
import type { ShellBreakpoint } from "../../state/types";
import { Cover } from "../../system/Cover";
import { Skeleton } from "../../system/Skeleton";
import type { StageId } from "../../types/stage";
import type { HostState, LoadFailure } from "./hostModels";
import { ShellFailureCover } from "./ShellFailureCover";

type HostBodyProps = {
  stage: StageId;
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  /** What the loading skeleton's Retry runs. */
  onRetry?: () => void;
  /** The pane that scrolls, for the saved offset. */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

/** The region's own title for a failure that has no cause of its own to name. */
function regionTitle(stage: StageId): string {
  return stage === "review"
    ? "The transcript didn't load"
    : "Could not load the project";
}

/** The load failure at region size: the Cover and its Try again. */
export function LoadFailureCover({
  stage,
  failure,
}: {
  stage: StageId;
  failure?: LoadFailure | null;
}) {
  if (failure?.source === "shell") {
    return <ShellFailureCover title={regionTitle(stage)} failure={failure} />;
  }
  return (
    <div role="alert">
      <Cover
        size="region"
        glyph="triangle-alert"
        title={regionTitle(stage)}
        primary={
          failure
            ? {
                label: "Try again",
                onClick: failure.onRetry,
                busy: failure.recovering,
              }
            : undefined
        }
      >
        Try again in a moment.
      </Cover>
    </div>
  );
}

/**
 * A stage host's scroller: the loading skeleton and the load failure Cover share it.
 * The failure Cover stays mounted while Try again runs, so its button keeps
 * focus.
 */
export function HostBody({
  stage,
  shell,
  state,
  failure,
  onRetry,
  scrollRef,
  children,
}: HostBodyProps) {
  return (
    <div
      ref={scrollRef}
      className={`stage-host stage-host--${stage} stage-host--${shell}`}
      data-stage-host={stage}
      aria-busy={state === "loading" ? true : undefined}
    >
      {state === "loading" ? (
        <Skeleton layout="list" onRetry={onRetry} />
      ) : state === "error" ? (
        <LoadFailureCover stage={stage} failure={failure} />
      ) : (
        children
      )}
    </div>
  );
}
