import { useRef, useState } from "react";
import type { KitListRow, KitRow } from "../api";
import { exportedMessage } from "../segments/importMessages";
import { useDawStore } from "../state/dawStore";
import { Skeleton } from "../system/Skeleton";
import { Button, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";
import { exportKitFile } from "./exportKit";
import { KitRowView } from "./KitRowView";
import type { KitLibraryState } from "./useKitLibrary";

export const KITS_LABEL = "Kits";
export const KITS_EMPTY_TEXT =
  "No kits yet. A kit is a saved set of segments, such as your intro and outro.";
export const KITS_LOAD_FAILED_TEXT = "Couldn't load the kits.";

type Props = { library: KitLibraryState };

export function KitLibraryBody({ library }: Props) {
  const { rows, error, reload } = library;
  const [failure, setFailure] = useState<string | null>(null);
  const exporting = useRef(false);

  const exportRow = async (row: KitRow) => {
    if (exporting.current) return;
    exporting.current = true;
    setFailure(null);
    const { announceStatus } = useDawStore.getState();
    announceStatus(`Preparing ${row.name} to export…`);
    try {
      const outcome = await exportKitFile(row.id);
      announceStatus(exportedMessage(row.name, outcome));
    } catch (problem) {
      const message = errorMessage(problem, `Couldn't export ${row.name}.`);
      announceStatus(message, { tone: "error" });
      setFailure(message);
    } finally {
      exporting.current = false;
    }
  };

  const retry = (
    <Button aria-label="Try again to load the kits" onClick={reload}>
      Try again
    </Button>
  );

  let content;
  if (rows === null && error === null) {
    content = (
      <>
        <p className="sr-only" role="status">
          Loading the kits
        </p>
        <Skeleton layout="list" rows={2} onRetry={reload} />
      </>
    );
  } else if (rows === null) {
    content = (
      <div className="kit-library-error" role="alert">
        <p className="kit-library-empty">{KITS_LOAD_FAILED_TEXT}</p>
        <p className="kit-library-detail">{error}</p>
        {retry}
      </div>
    );
  } else if (rows.length === 0) {
    content = <p className="kit-library-empty">{KITS_EMPTY_TEXT}</p>;
  } else {
    content = (
      <ul className="kit-list" aria-label={KITS_LABEL}>
        {rows.map((row: KitListRow) => (
          <KitRowView
            key={row.id}
            row={row}
            onExport={(target) => void exportRow(target)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="kit-library-body">
      <InlineError message={failure} />
      {rows !== null && error !== null ? (
        <div className="kit-library-error" role="alert">
          <p className="kit-library-detail">
            {KITS_LOAD_FAILED_TEXT} {error}
          </p>
          {retry}
        </div>
      ) : null}
      {content}
    </div>
  );
}
