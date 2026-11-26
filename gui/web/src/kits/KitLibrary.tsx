import { useId } from "react";
import { useDawStore } from "../state/dawStore";
import { KITS_LABEL, KitLibraryBody } from "./KitLibraryBody";
import type { KitLibraryState } from "./useKitLibrary";

type Props = {
  library: KitLibraryState;
  /** On Home the section is left out when there are no kits and nothing went wrong. */
  omitWhenEmpty?: boolean;
};

export function KitLibrary({ library, omitWhenEmpty = false }: Props) {
  const headingId = useId();
  const hosted = useDawStore((s) => s.guestMode === null);
  if (!hosted) return null;
  const empty = library.rows === null || library.rows.length === 0;
  if (omitWhenEmpty && empty && library.error === null) return null;
  return (
    <section className="kit-library" aria-labelledby={headingId}>
      <h2 id={headingId} className="sys-home-recent-title">
        {KITS_LABEL}
      </h2>
      <KitLibraryBody library={library} />
    </section>
  );
}
