import { useEffect, useMemo, useState } from "react";
import { executePointerCommand } from "../commands/pointer";
import { rangeActionDescriptors } from "../commands/rangeActions";
import { makeRangeTarget, resolveSelectionRange } from "../edit/rangeSelection";
import { useDaw } from "../state/useDaw";
import { Button } from "../ui";

export function RangeActions({ sheet = false }: { sheet?: boolean }) {
  const state = useDaw((s) => ({
    project: s.project,
    selection: s.selection,
    rangeArmed: s.rangeArmed,
    rangeBusy: s.rangeBusy,
    sessionRegion: s.sessionRegion,
    selectedTrackIds: s.selectedTrackIds,
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
    joinMutationInFlight: s.joinMutationInFlight,
    setSelection: s.setSelection,
    setRangeArmed: s.setRangeArmed,
    setSelectedTrackIds: s.setSelectedTrackIds,
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
  const descriptors = rangeActionDescriptors(state, target);
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
  return (
    <section
      className={`range-actions${sheet ? " range-actions--sheet" : ""}`}
      aria-label="Range actions"
    >
      {target ? (
        <p className="range-summary">
          {target.intervals
            .map((r) => `${r.start.toFixed(2)}–${r.end.toFixed(2)} s`)
            .join(" · ")}{" "}
          ·{" "}
          {target.track_ids
            .map((id) => project.tracks.find((t) => t.id === id)?.label ?? id)
            .join(", ")}
        </p>
      ) : null}
      {resolution.targets.length > 1 ? (
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
      {target ? (
        <div className="range-action-buttons">
          {descriptors.map((d) => (
            <div key={d.action} className="range-action">
              <Button
                type="button"
                className="ui-control--compact"
                disabled={d.reason !== null}
                aria-describedby={
                  d.reason
                    ? `range-${sheet ? "sheet" : "bar"}-${d.action}-reason`
                    : undefined
                }
                onClick={() =>
                  void executePointerCommand(d.commandId).then((result) => {
                    if (result.status === "disabled") setError(result.reason);
                  })
                }
              >
                {d.label}
              </Button>
              {d.reason ? (
                <small
                  id={`range-${sheet ? "sheet" : "bar"}-${d.action}-reason`}
                >
                  {d.reason}
                </small>
              ) : null}
            </div>
          ))}
          <Button
            type="button"
            className="ui-control--compact"
            disabled={state.rangeBusy}
            onClick={() => {
              state.setSelection(null);
              state.setRangeArmed(false);
            }}
          >
            Clear range
          </Button>
        </div>
      ) : null}
      {rangeArmed ? (
        <p>
          Drag across lanes to select. Use In and Out for precise touch
          selection.
        </p>
      ) : null}
      {rangeArmed || (sessionRegion && !target) ? (
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
                    state.setSelectedTrackIds(
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
          {sessionRegion ? (
            <Button
              type="button"
              className="ui-control--compact"
              disabled={selectedTrackIds.length === 0}
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
                if (next) state.setSelection({ kind: "range", target: next });
              }}
            >
              Use agent range on selected tracks
            </Button>
          ) : null}
          <Button
            type="button"
            className="ui-control--compact"
            onClick={() => state.setRangeArmed(false)}
          >
            Cancel range selection
          </Button>
        </div>
      ) : null}
      {!target && resolution.reason && resolution.targets.length === 0 ? (
        <p>{resolution.reason}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {state.rangeBusy ? <p role="status">Preparing range action…</p> : null}
    </section>
  );
}
