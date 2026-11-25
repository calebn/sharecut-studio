import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isDamagedSegment, type SegmentListRow } from "../api";
import { Skeleton } from "../system/Skeleton";
import { Button, InlineError } from "../ui";
import { stopAudition, toggleAudition, useAudition } from "./audition";
import { type RowLayout, SegmentRowView } from "./SegmentRowView";
import type { SegmentLibraryState } from "./useSegmentLibrary";

export const EMPTY_TEXT =
  "No saved segments yet. Segments you save to your library show up here.";
export const LOAD_FAILED_TEXT = "Couldn't load the segment library.";
export const LIBRARY_LABEL = "Segment library";

type Props = {
  library: SegmentLibraryState;
  layout: RowLayout;
};

type FocusRequest = { id: string; index: number };

function nameOf(row: SegmentListRow | undefined): string {
  if (!row) return "this segment";
  return isDamagedSegment(row) ? row.id : row.name;
}

function useSpokenAudition(rows: readonly SegmentListRow[]): string {
  const { playingId, failedId } = useAudition();
  const [stopped, setStopped] = useState(false);
  const active = playingId ?? failedId;
  if (active !== null && !stopped) setStopped(true);
  const name = nameOf(rows.find((row) => row.id === active));
  if (playingId !== null) return `Playing ${name}`;
  if (failedId !== null) return `Couldn't play ${name}`;
  return stopped ? "Stopped" : "";
}

export function SegmentLibraryBody({ library, layout }: Props) {
  const { rows, error, reload, remove } = library;
  const { playingId, failedId } = useAudition();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const spoken = useSpokenAudition(rows ?? []);

  useEffect(() => stopAudition, []);

  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request || confirmId !== null || removingId !== null) return;
    focusRequest.current = null;
    const scope = root.current;
    if (!scope) return;
    const more = [
      ...scope.querySelectorAll<HTMLElement>("[data-segment-more]"),
    ].find((el) => el.dataset.segmentMore === request.id);
    if (more) {
      more.focus();
      return;
    }
    const stops = [
      ...scope.querySelectorAll<HTMLElement>("[data-segment-focus]"),
    ];
    (
      stops[request.index] ??
      stops[request.index - 1] ??
      emptyRef.current
    )?.focus();
  }, [rows, confirmId, removingId]);

  const askRemove = (row: SegmentListRow) => {
    if (playingId === row.id) stopAudition();
    setDone(null);
    setFailure(null);
    setConfirmId(row.id);
  };

  const keep = (id: string) => {
    focusRequest.current = { id, index: 0 };
    setConfirmId(null);
  };

  const confirm = async (row: SegmentListRow) => {
    const index = (rows ?? []).findIndex((entry) => entry.id === row.id);
    focusRequest.current = { id: row.id, index };
    setRemovingId(row.id);
    const reason = await remove(row.id);
    setRemovingId(null);
    setConfirmId(null);
    if (reason === null) setDone(`Removed ${nameOf(row)} from the library.`);
    else setFailure(reason);
  };

  let content;
  if (rows === null && error === null) {
    content = (
      <>
        <p className="sr-only" role="status">
          Loading the segment library
        </p>
        <Skeleton layout="list" rows={3} onRetry={reload} />
      </>
    );
  } else if (rows === null) {
    content = (
      <div className="segment-library-error" role="alert">
        <p className="segment-library-empty">{LOAD_FAILED_TEXT}</p>
        <p className="segment-library-detail">{error}</p>
        <Button
          aria-label="Try again to load the segment library"
          onClick={reload}
        >
          Try again
        </Button>
      </div>
    );
  } else if (rows.length === 0) {
    content = (
      <p ref={emptyRef} tabIndex={-1} className="segment-library-empty">
        {EMPTY_TEXT}
      </p>
    );
  } else {
    const items = rows.map((row) => (
      <SegmentRowView
        key={row.id}
        row={row}
        layout={layout}
        playingId={playingId}
        failedId={failedId}
        confirmId={confirmId}
        removingId={removingId}
        onToggle={toggleAudition}
        onAskRemove={askRemove}
        onKeep={keep}
        onConfirm={(target) => void confirm(target)}
      />
    ));
    content =
      layout === "table" ? (
        <table className="segment-table">
          <caption className="sr-only">{LIBRARY_LABEL}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Audition</span>
              </th>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Length</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>{items}</tbody>
        </table>
      ) : (
        <ul className="segment-list" aria-label={LIBRARY_LABEL}>
          {items}
        </ul>
      );
  }

  return (
    <div ref={root} className="segment-library-body" data-layout={layout}>
      <p className="segment-library-note" role="status">
        {done}
      </p>
      <InlineError message={failure} />
      {content}
      <p className="sr-only" role="status">
        {spoken}
      </p>
    </div>
  );
}
