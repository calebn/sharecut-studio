import { useId } from "react";
import { LIBRARY_LABEL, SegmentLibraryBody } from "./SegmentLibraryBody";
import type { RowLayout } from "./SegmentRowView";
import type { SegmentLibraryState } from "./useSegmentLibrary";

type Props = {
  library: SegmentLibraryState;
  layout: RowLayout;
};

export function SegmentLibrary({ library, layout }: Props) {
  const headingId = useId();
  return (
    <section className="segment-library" aria-labelledby={headingId}>
      <h2 id={headingId} className="sys-home-recent-title">
        {LIBRARY_LABEL}
      </h2>
      <SegmentLibraryBody library={library} layout={layout} />
    </section>
  );
}
