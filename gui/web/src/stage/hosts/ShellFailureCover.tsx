import { shellFailureCover } from "../../shellLoadFailure";
import { Cover } from "../../system/Cover";
import { useCoverPress } from "../../system/useCoverPress";
import type { LoadFailure } from "./hostModels";

const ALL_PROJECTS = "All projects";

/**
 * The studio's first read of the episode failed: one fixed sentence for the
 * kind of failure, and the buttons that help for it. A press on Try again is
 * answered on the button and in a status line, and the sentence stays put.
 */
export function ShellFailureCover({
  title,
  failure,
}: {
  /** The region's own title, for a failure with no cause title of its own. */
  title: string;
  failure: Extract<LoadFailure, { source: "shell" }>;
}) {
  const cover = shellFailureCover(failure.cause, {
    stageTitle: title,
    name: failure.name,
  });
  const { busy, status, press } = useCoverPress({
    key: cover.key,
    trying: failure.trying ?? false,
    stillFailing: cover.stillFailing,
    changed: cover.changed,
  });
  const retry = cover.retry
    ? {
        label: cover.retry,
        onClick: () => {
          press();
          failure.onRetry();
        },
        busy,
        busyLabel: "Trying…",
      }
    : undefined;
  const home =
    cover.home && failure.onHome
      ? { label: ALL_PROJECTS, onClick: failure.onHome }
      : undefined;
  const [primary, secondary] = (
    cover.lead === "home" ? [home, retry] : [retry, home]
  ).filter((action) => action !== undefined);
  return (
    <div role="alert">
      <Cover
        size="region"
        glyph={cover.glyph}
        title={cover.title}
        primary={primary}
        secondary={secondary}
        status={retry ? status : undefined}
      >
        {cover.sentence}
      </Cover>
    </div>
  );
}
