import { useMemo } from "react";
import { timelineEndSec } from "../edit/pickupTarget";
import {
  clampSpan,
  defaultScope,
  makeRangeTarget,
  resolveSelectionRange,
  SPAN_STEP_SEC,
} from "../edit/rangeSelection";
import { TrackToggleRow } from "../inspector/TrackToggleRow";
import { isRangeSelection } from "../state/selection";
import { useDaw } from "../state/useDaw";
import { ScrubField } from "../system/ScrubField";
import { Button } from "../ui";

const SCOPE_HINT = "Pick a track in Scope to apply this range.";
const NO_TRACKS = "Choose at least one track";

/** A picked track can be removed before adoption, so only tracks still in the project count. */
function chosenScope(
  project: { tracks: readonly { id: string }[] },
  chosen: readonly string[] | null,
): readonly string[] {
  if (!chosen) return [];
  const live = new Set(project.tracks.map((track) => track.id));
  return chosen.filter((id) => live.has(id));
}

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
    announceStatus: s.announceStatus,
    setSelection: s.setSelection,
    commitRange: s.commitRange,
    setRangeDraft: s.setRangeDraft,
    agentRangeScope: s.agentRangeScope,
    setAgentRangeScope: s.setAgentRangeScope,
  }));
  const { project, selection, rangeArmed, rangeDraft, sessionRegion } = state;
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
  const timelineEnd = timelineEndSec(project);
  const drafting =
    rangeArmed && rangeDraft != null && !isRangeSelection(selection);
  const draftSpan = drafting ? clampSpan(rangeDraft, timelineEnd) : null;
  const span = target
    ? { start: target.intervals[0]!.start, end: target.intervals.at(-1)!.end }
    : draftSpan;
  const single = target ? target.intervals.length === 1 : span !== null;
  const inSec = span?.start ?? 0;
  const outSec = span?.end ?? 0;
  const scope =
    target?.track_ids ??
    (drafting
      ? chosenScope(project, rangeDraft.trackIds)
      : chosenScope(project, state.agentRangeScope));
  const editable = showNumeric && span !== null && (always || drafting);
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
  const commitSpan = (start: number, end: number) => {
    const next = makeRangeTarget(project, [{ start, end }], scope);
    if (!next) {
      if (drafting) state.setRangeDraft({ start, end, trackIds: scope });
      state.announceStatus(NO_TRACKS, { tone: "error" });
      return;
    }
    state.commitRange(next);
    if (!target)
      state.announceStatus(
        `Range ${start.toFixed(2)}–${end.toFixed(2)} s selected`,
      );
  };
  const commitScope = (ids: string[]) => {
    const spans = target?.intervals ?? (draftSpan ? [draftSpan] : null);
    if (!spans) {
      state.setAgentRangeScope(ids);
      return;
    }
    const next = makeRangeTarget(project, spans, ids);
    if (next) {
      state.commitRange(next);
      return;
    }
    if (draftSpan) state.setRangeDraft({ ...draftSpan, trackIds: ids });
    state.announceStatus(NO_TRACKS, { tone: "error" });
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
        skipUnchanged={!drafting}
        commitUnchanged={drafting}
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
                max: timelineEnd,
              })}
              {field(
                "Length",
                outSec - inSec,
                (v) => commitSpan(inSec, inSec + v),
                { min: SPAN_STEP_SEC, max: timelineEnd - inSec },
              )}
            </>
          ) : null}
          <TrackToggleRow
            label="Scope"
            tracks={tracks}
            value={scope}
            onChange={commitScope}
          />
          {drafting && scope.length === 0 ? (
            <p className="range-scope-hint">{SCOPE_HINT}</p>
          ) : null}
          {agent ? (
            <Button
              type="button"
              className="ui-control--compact"
              onClick={() => {
                const next = makeRangeTarget(
                  project,
                  [
                    {
                      start: sessionRegion!.start_sec,
                      end: sessionRegion!.end_sec,
                    },
                  ],
                  scope.length ? scope : defaultScope(project, selection),
                );
                if (next) state.commitRange(next);
                else state.announceStatus(NO_TRACKS, { tone: "error" });
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
