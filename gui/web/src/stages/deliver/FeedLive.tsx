import { useState } from "react";
import { FeedSection } from "./FeedSection";
import { applyFix } from "./feedFixture";
import type { FeedView, Fix } from "./feedView";

type Props = React.ComponentProps<typeof FeedSection>;

/** Stands in for the service: applies each action to the view and passes it on. */
export function FeedLive({ view: first, onAction, ...rest }: Props) {
  const [view, setView] = useState<FeedView>(first);
  return (
    <FeedSection
      {...rest}
      view={view}
      onAction={(fix: Fix) => {
        onAction(fix);
        setView((now) => applyFix(now, fix));
      }}
    />
  );
}
