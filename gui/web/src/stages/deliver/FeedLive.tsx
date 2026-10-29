import { useState } from "react";
import { FeedSection } from "./FeedSection";
import { applyFix, type Served, serve } from "./feedFixture";
import type { Fix } from "./feedView";

type Props = Omit<React.ComponentProps<typeof FeedSection>, "itemXml">;

/** Stands in for the service: applies each action to the view and the rendered item, and passes them on. */
export function FeedLive({ view: first, onAction, ...rest }: Props) {
  const [served, setServed] = useState<Served>(() => serve(first));
  return (
    <FeedSection
      {...rest}
      view={served.view}
      itemXml={served.itemXml}
      onAction={(fix: Fix) => {
        onAction(fix);
        setServed((now) => applyFix(now, fix));
      }}
    />
  );
}
