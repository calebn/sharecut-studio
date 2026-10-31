import { useEffect, useMemo, useState } from "react";
import { makeRangeTarget, resolveSelectionRange } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { inspectorOpenFor, selectedTrackIdsOf } from "../state/selection";
import { useDaw } from "../state/useDaw";
import { WordRangeControls } from "../transcript/WordRangeControls";
import { Button } from "../ui";

export function RangeFields({
  sheet = false,
  always = false,
  numeric: showNumeric = true,
}: {
  sheet?: boolean;
  numeric?: boolean;
  always?: boolean;
}) {
  const state = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    rangeArmed: s.rangeArmed,
    rangeBusy: s.rangeBusy,
    sessionRegion: s.sessionRegion,
    selectedTrackIds: s.rangeScopeTrackIds ?? selectedTrackIdsOf(s.selection),
    setSelection: s.setSelection,
    setRangeArmed: s.setRangeArmed,
    setRangeScopeTrackIds: s.setRangeScopeTrackIds,
  }));
  const { project, selection, rangeArmed, sessionRegion, selectedTrackIds } =
    state;
  const resolution = useMemo(
    () =>
      project
        ? resolveSelectionRange(project, selection)
        : { targets: [], reason: null },
    [project, selection],
  );
  const target =
    resolution.targets.length === 1 ? resolution.targets[0]! : null;
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("1");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (target) {
      setStart(String(target.intervals[0]!.start));
      setEnd(String(target.intervals.at(-1)!.end));
    }
  }, [target]);
  if (
    !project ||
    (!rangeArmed &&
      !target &&
      selection?.kind !== "transcriptRange" &&
      !sessionRegion)
  )
    return null;
  function selectNumeric() {
    if (!project) return;
    if (!start.trim() || !end.trim()) {
      setError("Enter an In and Out time");
      return;
    }
    const next = makeRangeTarget(
      project,
      [{ start: Number(start), end: Number(end) }],
      selectedTrackIds,
    );
    if (!next) {
      setError("Enter an In before Out and choose at least one track");
      return;
    }
    state.setSelection({ kind: "range", target: next });
    state.setRangeArmed(false);
  }
  const chooser = resolution.targets.length > 1;
  const wordHandles = selection?.kind === "transcriptRange";
  const numeric =
    showNumeric &&
    (rangeArmed || (always && target) || (sessionRegion && !target));
  const unresolved =
    selection?.kind === "transcriptRange" &&
    !target &&
    resolution.reason &&
    resolution.targets.length === 0;
  if (
    !(
      chooser ||
      wordHandles ||
      numeric ||
      unresolved ||
      error ||
      state.rangeBusy
    )
  )
    return null;
  return (
    <section
      className={`range-actions${sheet ? " range-actions--sheet" : ""}`}
      aria-label="Range fields"
    >
      {chooser ? (
        <div>
          <p>Choose the audible occurrence.</p>
          {resolution.targets.map((choice, index) => (
            <Button
              type="button"
              className="ui-control--compact"
              key={`${choice.intervals[0]!.start}:${index}`}
              onClick={() =>
                state.setSelection({ kind: "range", target: choice })
              }
            >
              Occurrence {index + 1} ·{" "}
              {choice.intervals
                .map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`)
                .join(" · ")}{" "}
              · {choice.track_ids.join(", ")}
            </Button>
          ))}
        </div>
      ) : null}
      {wordHandles && selection?.kind === "transcriptRange" ? (
        <WordRangeControls selection={selection} />
      ) : null}
      {numeric ? (
        <div className="range-numeric">
          <label>
            In{" "}
            <input
              type="number"
              min="0"
              step="0.01"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            Out{" "}
            <input
              type="number"
              min="0"
              step="0.01"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>Selected tracks</legend>
            {project.tracks.map((track) => (
              <label key={track.id}>
                <input
                  type="checkbox"
                  checked={selectedTrackIds.includes(track.id)}
                  onChange={(e) =>
                    state.setRangeScopeTrackIds(
                      e.target.checked
                        ? [...selectedTrackIds, track.id]
                        : selectedTrackIds.filter((id) => id !== track.id),
                    )
                  }
                />
                {track.label}
              </label>
            ))}
          </fieldset>
          <Button
            type="button"
            className="ui-control--compact"
            onClick={selectNumeric}
          >
            Select range
          </Button>
          {sessionRegion && (rangeArmed || !target) ? (
            <Button
              type="button"
              className="ui-control--compact"
              disabledReason={
                selectedTrackIds.length === 0
                  ? "Select at least one track to use the agent range."
                  : undefined
              }
              onClick={() => {
                const next = makeRangeTarget(
                  project,
                  [
                    {
                      start: sessionRegion.start_sec,
                      end: sessionRegion.end_sec,
                    },
                  ],
                  selectedTrackIds,
                );
                if (next) {
                  const held = useDawStore.getState();
                  const wasOpen = inspectorOpenFor(
                    held.selection,
                    held.inspectorKey,
                  );
                  state.setSelection({ kind: "range", target: next });
                  if (wasOpen) held.setInspectorOpen(true);
                  state.setRangeScopeTrackIds(null);
                }
              }}
            >
              Use agent range on selected tracks
            </Button>
          ) : null}
          {rangeArmed ? (
            <Button
              type="button"
              className="ui-control--compact"
              onClick={() => {
                state.setRangeArmed(false);
                if (selection?.kind === "track") state.setSelection(null);
              }}
            >
              Cancel range selection
            </Button>
          ) : null}
        </div>
      ) : null}
      {unresolved ? <p>{resolution.reason}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {state.rangeBusy ? <p role="status">Preparing range action…</p> : null}
    </section>
  );
}
