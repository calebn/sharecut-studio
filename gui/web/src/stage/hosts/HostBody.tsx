import type { ReactNode, Ref } from "react";
import { Cover } from "../../system/Cover";
import { Skeleton } from "../../system/Skeleton";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import type { HostShell, HostState } from "./hostModels";

type Props = {
  stage: string;
  shell: HostShell;
  state: HostState;
  failure?: LoadFailure | null;
  /** The pane that scrolls, for the saved offset. */
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

/** A stage host's scroller: the loading skeleton and the load failure Cover share it. */
export function HostBody({
  stage,
  shell,
  state,
  failure,
  scrollRef,
  children,
}: Props) {
  return (
    <div
      ref={scrollRef}
      className={`stage-host stage-host--${stage} stage-host--${shell}`}
      data-stage-host={stage}
      aria-busy={state === "loading" ? true : undefined}
    >
      {state === "loading" ? (
        <Skeleton layout="list" />
      ) : state === "error" ? (
        <Cover
          size="region"
          glyph="triangle-alert"
          title="Could not load the project"
          primary={
            failure ? { label: "Retry", onClick: failure.onRetry } : undefined
          }
        >
          {failure?.message ?? "Try again in a moment."}
        </Cover>
      ) : (
        children
      )}
    </div>
  );
}
