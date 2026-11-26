import { type RefObject, useEffect, useRef, useState } from "react";
import type { KitListRow, KitRow, KitSaveResult, SegmentListRow } from "../api";
import { exportedMessage } from "../segments/importMessages";
import { useDawStore } from "../state/dawStore";
import { Skeleton } from "../system/Skeleton";
import { SystemIcon } from "../system/SystemIcon";
import { Button, InlineError } from "../ui";
import { ApiError, errorMessage } from "../utils/apiError";
import { exportKitFile } from "./exportKit";
import { KitEditorSheet, NEW_KIT_LABEL } from "./KitEditorSheet";
import { KitRowView } from "./KitRowView";
import { kitSavedMessage } from "./kitSaveMessages";
import type { KitLibraryState } from "./useKitLibrary";

export const KITS_LABEL = "Kits";
export const KIT_LIST_LABEL = "Saved kits";
export const KITS_EMPTY_TEXT =
  "No kits yet. A kit is a saved set of segments, such as your intro and outro.";
export const KITS_LOAD_FAILED_TEXT = "Couldn't load the kits.";

/** What New kit needs of the segment library: its rows, and a way to read them again. */
export type KitSegments = {
  rows: readonly SegmentListRow[] | null;
  reload: () => void;
};

type Props = {
  library: KitLibraryState;
  /** Offers New kit when given; left out where a kit cannot be built. */
  segments?: KitSegments;
  /** What an export last failed with; held by the section so it outlives an emptied list. */
  failure: string | null;
  onFailure: (message: string | null) => void;
  /** Takes focus when a refused export leaves the list out of date. */
  focusTarget?: RefObject<HTMLElement | null>;
};

export function KitLibraryBody({
  library,
  segments,
  failure,
  onFailure,
  focusTarget,
}: Props) {
  const { rows, error, reload, reveal, highlightId } = library;
  const exporting = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // The saved kit that takes focus once the list shows it.
  const revealed = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (highlightId === null || revealed.current !== highlightId) return;
    revealed.current = null;
    const row = Array.from(
      body.current?.querySelectorAll<HTMLElement>("[data-kit-row]") ?? [],
    ).find((item) => item.dataset.kitRow === highlightId);
    row?.focus();
  }, [highlightId, rows]);

  const saved = (result: KitSaveResult, name: string, count: number) => {
    revealed.current = result.id;
    reveal(result.id);
    useDawStore.getState().announceStatus(kitSavedMessage(name, result, count));
  };

  const exportRow = async (row: KitRow) => {
    if (exporting.current) return;
    exporting.current = true;
    onFailure(null);
    const signal = lifetime.current?.signal;
    const { announceStatus } = useDawStore.getState();
    announceStatus(`Preparing ${row.name} to export…`);
    try {
      const outcome = await exportKitFile(row.id, signal);
      announceStatus(exportedMessage(row.name, outcome));
    } catch (problem) {
      if (signal?.aborted) return;
      // The alert below is the one announcement of a failure.
      onFailure(errorMessage(problem, `Couldn't export ${row.name}.`));
      // The kit is gone (404) or its segments are (409): the list is out of date, and
      // the row that held focus is about to change or go.
      if (
        problem instanceof ApiError &&
        (problem.status === 404 || problem.status === 409)
      ) {
        const target = focusTarget?.current;
        const active = document.activeElement;
        if (
          target &&
          (active === document.body || target.parentElement?.contains(active))
        )
          target.focus();
        reload();
      }
    } finally {
      exporting.current = false;
    }
  };

  const retry = (
    <Button aria-label="Try again to load the kits" onClick={reload}>
      Try again
    </Button>
  );

  const loading = rows === null && error === null;
  let content;
  if (loading) {
    content = <Skeleton layout="list" rows={2} onRetry={reload} />;
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
      <ul className="kit-list" aria-label={KIT_LIST_LABEL}>
        {rows.map((row: KitListRow) => (
          <KitRowView
            key={row.id}
            row={row}
            highlighted={highlightId === row.id}
            onExport={(target) => void exportRow(target)}
          />
        ))}
      </ul>
    );
  }

  return (
    <div ref={body} className="kit-library-body">
      <p className="sr-only" role="status">
        {loading ? "Loading the kits" : ""}
      </p>
      {segments ? (
        <div className="kit-library-actions">
          <Button className="kit-new-button" onClick={() => setEditing(true)}>
            <SystemIcon name="plus" size={16} />
            {NEW_KIT_LABEL}
          </Button>
          <KitEditorSheet
            open={editing}
            onClose={() => setEditing(false)}
            segments={segments.rows}
            kits={rows}
            onSaved={saved}
            onSegmentsChanged={segments.reload}
          />
        </div>
      ) : null}
      <InlineError message={failure} />
      {content}
    </div>
  );
}
