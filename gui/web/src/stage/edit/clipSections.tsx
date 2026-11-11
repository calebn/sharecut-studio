import { useEffect, useId } from "react";
import { commandLabel } from "../../commands/labels";
import { executePointerCommand } from "../../commands/pointer";
import { saveClipEdge, TRIM_MODE } from "../../edit/clipEdgeSave";
import { CLIP_HANDLE_STEPS } from "../../edit/clipHandleSteps";
import { cancelClipPlacement } from "../../edit/clipPlacement";
import { edgeFadeMaxMs, maxFadeMs } from "../../edit/fadeLimits";
import {
  clipIdsBeforeCut,
  cutFadeHint,
  isCutJoin,
  JOIN_AUDITION_PAD_SEC,
} from "../../edit/joinRender";
import { muteRegionsOverlapping } from "../../edit/muteRegions";
import { seamsOnTrack } from "../../edit/seam";
import { trimEdgeLimits } from "../../edit/trimLimits";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { canApplyPass12, canSuggestStructural } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { selectedClipIdsOf } from "../../state/selection";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import { nudgeDriver } from "../../timeline/precision/precisionDrivers";
import type { Selection } from "../../types/project";
import { Button, InspectorSeekFooter } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { ClipStartField, ClipTrackRow } from "./clipPlacementFields";
import { CLIP_READ_ONLY_REASON } from "./clipReadOnly";
import { multiClipSections } from "./multiClipSections";
import {
  joinLengthRows,
  joinOffsetRows,
  joinTypeRows,
  type SeamJoinFields,
  useSeamJoinFields,
} from "./seamJoinFields";
import { note } from "./sheetNote";

function joinRows(fields: SeamJoinFields | null) {
  if (!fields?.seam.abuts) return [];
  return [
    ...joinTypeRows(fields),
    ...joinLengthRows(fields),
    ...joinOffsetRows(fields),
  ];
}

const FADE_LIMIT_LOADING = "The fade limit is still loading. Wait a moment.";

export function useClipSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const {
    project,
    projectPath,
    projectEpoch,
    guestMode,
    shareCapabilities,
    joinBusy,
  } = useDaw((s) => ({
    joinBusy: s.joinMutationInFlight,
    project: s.project,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const { busy, error, setError, run } = useProjectMutation();
  const readOnlyId = useId();
  const id = selection?.kind === "clip" ? selection.id : null;
  const selectedIds = selectedClipIdsOf(selection);
  const clip =
    id === null
      ? undefined
      : Object.values(project?.clips.tracks ?? {})
          .flat()
          .find((candidate) => candidate.id === id);
  const track = project?.tracks.find((t) => t.id === clip?.track_id);
  const capMs = track === undefined ? undefined : (track.fade_max_ms ?? null);
  const joinHost = {
    busy,
    onEdit: cancelClipPlacement,
    resetKey: JSON.stringify([
      projectPath,
      projectEpoch,
      selectedIds,
      clip?.id,
      clip?.track_id,
      clip?.source_start,
      clip?.source_end,
      clip?.fade_in_ms,
      clip?.fade_out_ms,
      capMs,
    ]),
  };
  const seams =
    project && clip && selectedIds.length <= 1
      ? seamsOnTrack(project, clip.track_id)
      : [];
  const leading = useSeamJoinFields(
    seams.find((seam) => seam.right.id === clip?.id)?.id ?? null,
    "start",
    joinHost,
  );
  const trailing = useSeamJoinFields(
    seams.find((seam) => seam.left.id === clip?.id)?.id ?? null,
    "end",
    joinHost,
  );
  useEffect(() => {
    setError(null);
  }, [
    projectPath,
    projectEpoch,
    selectedIds,
    clip?.id,
    clip?.track_id,
    clip?.source_start,
    clip?.source_end,
    clip?.fade_in_ms,
    clip?.fade_out_ms,
    capMs,
    setError,
  ]);
  if (id === null) return null;
  if (selectedIds.length > 1)
    return multiClipSections({
      project,
      clipIds: selectedIds,
      projectPath,
      locked:
        !canApplyPass12(projectPath, guestMode, shareCapabilities) || busy,
      readOnly: !canApplyPass12(projectPath, guestMode, shareCapabilities),
      error,
      run,
    });
  if (!clip)
    return [
      { id: "gone", rows: [{ id: "gone", control: note("Clip not found") }] },
    ];

  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const canStructural = canSuggestStructural(
    projectPath,
    guestMode,
    shareCapabilities,
  );
  const lane = project?.clips.tracks[clip.track_id] ?? [];
  const index = lane.findIndex((item) => item.id === clip.id);
  const capKnown = capMs !== undefined;
  const clipSec = clip.source_end - clip.source_start;
  const cutIn = isCutJoin(clip);
  const cutOut = clipIdsBeforeCut(lane).has(clip.id);
  const played = muteRegionsOverlapping(
    clip.mute_regions,
    clip.source_start,
    clip.source_end,
  );
  const locked = !editable || busy || joinBusy;

  const trim = async (edge: "in" | "out", value: number) => {
    if (locked) return;
    const fresh = () => {
      const state = useDawStore.getState();
      const latest = state.project?.clips.tracks[clip.track_id]?.find(
        (item) => item.id === clip.id,
      );
      return (
        state.projectPath === projectPath &&
        state.projectEpoch === projectEpoch &&
        latest?.source_start === clip.source_start &&
        latest.source_end === clip.source_end
      );
    };
    if (!fresh()) {
      setError("This clip changed. Reload its source bounds before trimming.");
      return;
    }
    cancelClipPlacement();
    await run(() =>
      saveClipEdge(
        projectPath,
        clip,
        { kind: "trim", edge, mode: TRIM_MODE, sourceSec: value },
        fresh,
      ),
    );
  };

  const fade = async (edge: "in" | "out", value: number) => {
    if (locked || !capKnown) return;
    cancelClipPlacement();
    await run(async () => {
      const driver = nudgeDriver(
        { kind: "fade", trackId: clip.track_id, clipId: clip.id, edge },
        edge === "in" ? "Fade in" : "Fade out",
      );
      if (!driver.begin()) return;
      driver.show(value);
      await driver.commit();
    });
  };

  const ripple = async () => {
    if (busy) return;
    cancelClipPlacement();
    await run(async () => {
      const result = await executePointerCommand("edit.rippleDelete", {
        clipId: clip.id,
      });
      if (result.status !== "ok")
        throw new Error(
          result.status === "disabled"
            ? result.reason
            : "Delete command unknown",
        );
    });
  };

  const edge = (which: "in" | "out") => {
    const limits =
      index < 0 ? null : trimEdgeLimits(lane, index, which, TRIM_MODE);
    return (
      <ScrubField
        label={`Source ${which === "in" ? "start" : "end"}`}
        value={which === "in" ? clip.source_start : clip.source_end}
        unit="s"
        step={CLIP_HANDLE_STEPS.trim.small}
        decimals={3}
        skipUnchanged
        min={limits?.lo}
        max={limits?.hi}
        readOnly={locked}
        onCommit={(value) => void trim(which, value)}
      />
    );
  };

  const outLimits =
    index < 0 ? null : trimEdgeLimits(lane, index, "out", TRIM_MODE);
  const timed = (clip.timing?.steps.length ?? 0) > 0;
  const timelineLength = clip.timeline_end - clip.timeline_start;
  const outEdgeField = (
    label: string,
    value: number,
    offset: number,
    toLength: (value: number) => number,
  ) => (
    <ScrubField
      label={label}
      value={value}
      unit="s"
      step={CLIP_HANDLE_STEPS.trim.small}
      decimals={3}
      skipUnchanged
      min={outLimits ? offset + outLimits.lo - clip.source_start : undefined}
      max={outLimits ? offset + outLimits.hi - clip.source_start : undefined}
      readOnly={locked || timed}
      onCommit={(next) => void trim("out", clip.source_start + toLength(next))}
    />
  );
  const endField = outEdgeField(
    "End",
    clip.timeline_end,
    clip.timeline_start,
    (value) => value - clip.timeline_start,
  );
  const lengthField = outEdgeField(
    "Length",
    timelineLength,
    0,
    (value) => value,
  );

  const fadeField = (which: "in" | "out") => {
    const atCut = which === "in" ? cutIn : cutOut;
    return (
      <ScrubField
        label={which === "in" ? "Fade in" : "Fade out"}
        value={which === "in" ? clip.fade_in_ms : clip.fade_out_ms}
        unit="ms"
        step={CLIP_HANDLE_STEPS.fade.small}
        decimals={0}
        integerOnly
        min={0}
        max={edgeFadeMaxMs(
          clipSec,
          capMs,
          which === "in" ? clip.fade_out_ms : clip.fade_in_ms,
        )}
        readOnly={locked || !capKnown || atCut}
        onCommit={(value) => void fade(which, value)}
      />
    );
  };

  const fadeHint = cutFadeHint(cutIn, cutOut);
  const joinSec = clip.timeline_start;
  return [
    {
      id: "clip",
      rows: [
        {
          id: "start",
          label: "Start",
          control: <ClipStartField clip={clip} disabled={locked} />,
        },
        { id: "end", label: "End", control: endField },
        { id: "length", label: "Length", control: lengthField },
        { id: "in", label: "Source start", control: edge("in") },
        { id: "out", label: "Source end", control: edge("out") },
        { id: "fadeIn", label: "Fade in", control: fadeField("in") },
        { id: "fadeOut", label: "Fade out", control: fadeField("out") },
        {
          id: "track",
          label: "Track",
          control: (
            <ClipTrackRow
              clip={clip}
              tracks={(project?.tracks ?? []).map((t) => ({
                id: t.id,
                label: t.label || t.id,
              }))}
              disabled={locked}
              reasonId={editable ? undefined : readOnlyId}
            />
          ),
        },
        ...(editable
          ? [
              {
                id: "fadeNote",
                control: note(
                  capKnown
                    ? [fadeHint, `max ${maxFadeMs(clipSec, capMs)} ms`]
                        .filter(Boolean)
                        .join(" · ")
                    : FADE_LIMIT_LOADING,
                  "status",
                ),
              },
            ]
          : [
              {
                id: "readOnlyNote",
                control: note(CLIP_READ_ONLY_REASON, "status", readOnlyId),
              },
            ]),
        ...joinRows(leading),
        ...joinRows(trailing),
        ...(played.length === 0
          ? []
          : [
              {
                id: "mutes",
                label: "Mute regions",
                control: played
                  .map(
                    (region) =>
                      `${region.start_s.toFixed(3)}–${region.end_s.toFixed(3)} s${region.gain_db ? ` (${region.gain_db} dB)` : ""}`,
                  )
                  .join(", "),
              },
            ]),
        ...(clip.timing_summary
          ? [
              {
                id: "timing",
                label: "Timing",
                control: clip.timing_summary,
              },
            ]
          : []),
        {
          id: "bleed",
          label: "Auto reduction",
          control: (
            <Button
              disabledReason={busy || joinBusy ? BUSY_REASON : undefined}
              onClick={() => {
                cancelClipPlacement();
                useDawStore.getState().setSelection({
                  kind: "bleedAttenuation",
                  id: clip.id,
                  trackId: clip.track_id,
                  regionKey: null,
                });
              }}
            >
              Inspect automatic audio reduction
            </Button>
          ),
        },
        ...(
          [
            ["error", error],
            ["error-start", leading?.error],
            ["error-end", trailing?.error],
          ] as const
        ).flatMap(([id, message]) =>
          message ? [{ id, control: note(message, "alert") }] : [],
        ),
      ],
    },
    {
      id: "more",
      title: "More",
      rows: [
        {
          id: "seek",
          control: (
            <InspectorSeekFooter
              seekSec={joinSec}
              playStart={joinSec}
              playEnd={joinSec}
              padSec={JOIN_AUDITION_PAD_SEC}
              seekLabel="Seek join"
              playLabel="Play across join"
            />
          ),
        },
        ...(canStructural
          ? [
              {
                id: "ripple",
                control: (
                  <Button
                    disabledReason={busy || joinBusy ? BUSY_REASON : undefined}
                    onClick={() => void ripple()}
                  >
                    {commandLabel("edit.rippleDelete", "short")}
                  </Button>
                ),
              },
              {
                id: "ripple-note",
                control: note(
                  "Cut on the bar leaves a gap. Ripple delete closes it on every dialogue track.",
                ),
              },
            ]
          : []),
      ],
    },
  ];
}
