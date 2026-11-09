import { useMemo } from "react";
import {
  makeRangeTarget,
  resolveSelectionRange,
  SPAN_STEP_SEC,
  seedRangeDraft,
} from "../edit/rangeSelection";
import { TrackToggleRow } from "../inspector/TrackToggleRow";
import { useDawStore } from "../state/dawStore";
import { selectedTrackIdsOf } from "../state/selection";
import { useDaw } from "../state/useDaw";
import { ScrubField } from "../system/ScrubField";
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
    rangeDraft: s.rangeDraft,
    selectedTrackIds: s.rangeDraft?.trackIds ?? selectedTrackIdsOf(s.selection),
    setSelection: s.setSelection,
    commitRange: s.commitRange,
    setRangeDraft: s.setRangeDraft,
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
  if (
    !project ||
    (!rangeArmed &&
      !target &&
      selection?.kind !== "transcriptRange" &&
      !sessionRegion)
  )
    return null;
  const chooser = resolution.targets.length > 1;
  const single = target !== null && target.intervals.length === 1;
  const inSec = target?.intervals[0]!.start ?? 0;
  const outSec = target?.intervals.at(-1)!.end ?? 0;
  const editable = showNumeric && always && target !== null;
  const agent = showNumeric && sessionRegion && (rangeArmed || !target);
  const unresolved =
    selection?.kind === "transcriptRange" &&
    !target &&
    resolution.reason &&
    resolution.targets.length === 0;
  if (!(chooser || editable || agent || unresolved || state.rangeBusy))
    return null;
  const tracks = project.tracks.map((track) => ({
    id: track.id,
    label: track.label,
  }));
  // Each field commits the range it describes; the selection is the range.
  const commitSpan = (start: number, end: number) => {
    const next = makeRangeTarget(
      project,
      [{ start, end }],
      target?.track_ids ?? selectedTrackIds,
    );
    if (next) state.setSelection({ kind: "range", target: next });
  };
  const commitScope = (ids: string[]) => {
    if (!target) {
      const base =
        state.rangeDraft ??
        seedRangeDraft(project, useDawStore.getState().playheadSec, selection);
      if (base) state.setRangeDraft({ ...base, trackIds: ids });
      return;
    }
    const next = makeRangeTarget(project, target.intervals, ids);
    if (next) state.setSelection({ kind: "range", target: next });
  };
  const field = (
    label: string,
    value: number,
    commit: (value: number) => void,
    bounds: { min: number; max?: number },
  ) => (
    <label className="range-field">
      <span>{label}</span>
      <ScrubField
        label={label}
        value={value}
        unit="s"
        step={SPAN_STEP_SEC}
        decimals={3}
        skipUnchanged
        readOnly={!single}
        min={bounds.min}
        max={bounds.max}
        onCommit={commit}
      />
    </label>
  );
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
      {editable || agent ? (
        <div className="range-numeric">
          {editable ? (
            <>
              {field("In", inSec, (v) => commitSpan(v, outSec), {
                min: 0,
                max: outSec - SPAN_STEP_SEC,
              })}
              {field("Out", outSec, (v) => commitSpan(inSec, v), {
                min: inSec + SPAN_STEP_SEC,
              })}
              {field(
                "Length",
                outSec - inSec,
                (v) => commitSpan(inSec, inSec + v),
                { min: SPAN_STEP_SEC },
              )}
            </>
          ) : null}
          <TrackToggleRow
            label="Scope"
            tracks={tracks}
            value={target?.track_ids ?? selectedTrackIds}
            onChange={commitScope}
          />
          {agent ? (
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
                      start: sessionRegion!.start_sec,
                      end: sessionRegion!.end_sec,
                    },
                  ],
                  selectedTrackIds,
                );
                if (next) state.commitRange(next);
              }}
            >
              Use agent range on selected tracks
            </Button>
          ) : null}
        </div>
      ) : null}
      {unresolved ? <p>{resolution.reason}</p> : null}
      {state.rangeBusy ? <p role="status">Preparing range action…</p> : null}
    </section>
  );
}
