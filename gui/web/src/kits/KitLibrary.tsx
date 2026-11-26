import { useId, useRef, useState } from "react";
import { useDawStore } from "../state/dawStore";
import { useBundleImport } from "../system/importSheet/BundleImportContext";
import { KITS_LABEL, KitLibraryBody, type KitSegments } from "./KitLibraryBody";
import { healthySegments } from "./kitEditorCopy";
import type { KitLibraryState } from "./useKitLibrary";

type Props = {
  library: KitLibraryState;
  /** The segment library, which New kit builds from. Without it there is no New kit button. */
  segments?: KitSegments;
  /**
   * On Home the section is left out when there are no kits, nothing went wrong and there is
   * no segment to build one from.
   */
  omitWhenEmpty?: boolean;
};

export function KitLibrary({
  library,
  segments,
  omitWhenEmpty = false,
}: Props) {
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const hosted = useDawStore((s) => s.guestMode === null);
  const imports = useBundleImport();
  if (!hosted) return null;
  const empty = library.rows === null || library.rows.length === 0;
  const canBuild =
    segments !== undefined && healthySegments(segments.rows).length > 0;
  if (
    omitWhenEmpty &&
    empty &&
    library.error === null &&
    failure === null &&
    !canBuild
  )
    return null;
  return (
    <section className="kit-library" aria-labelledby={headingId}>
      <h2
        ref={(element) => {
          heading.current = element;
          if (imports) imports.kitsHeadingRef.current = element;
        }}
        id={headingId}
        tabIndex={-1}
        className="sys-home-recent-title"
      >
        {KITS_LABEL}
      </h2>
      <KitLibraryBody
        library={library}
        segments={segments}
        failure={failure}
        onFailure={setFailure}
        focusTarget={heading}
      />
    </section>
  );
}
