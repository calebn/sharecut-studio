import { useEffect } from "react";
import { setClipJoin } from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
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
  joinModeLabel,
  joinRenderNote,
} from "../../edit/joinRender";
import { muteRegionsOverlapping } from "../../edit/muteRegions";
import { trimEdgeLimits } from "../../edit/trimLimits";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { ClipPlacementControls } from "../../inspector/views/ClipPlacementControls";
import { canApplyPass12, canSuggestStructural } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import { nudgeDriver } from "../../timeline/precision/precisionDrivers";
import type { Selection } from "../../types/project";
import { Button, InspectorSeekFooter } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { JOIN_MODE_OPTIONS } from "../../utils/editMarkerRegistry";
import { note } from "./sheetNote";

const FADE_LIMIT_LOADING = "The fade limit is still loading. Wait a moment.";

export function useClipSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath, projectEpoch, guestMode, shareCapabilities } =
    useDaw((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }));
  const { busy, error, setError, run } = useProjectMutation();
  const id = selection?.kind === "clip" ? selection.id : null;
  const clip =
    id === null
      ? undefined
      : Object.values(project?.clips.tracks ?? {})
          .flat()
          .find((candidate) => candidate.id === id);
  const track = project?.tracks.find((t) => t.id === clip?.track_id);
  const capMs = track === undefined ? undefined : (track.fade_max_ms ?? null);
  useEffect(() => {
    setError(null);
  }, [
    projectPath,
    projectEpoch,
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
  const leftClipId = clip.join_left_clip_id ?? null;
  const cutIn = isCutJoin(clip);
  const cutOut = clipIdsBeforeCut(lane).has(clip.id);
  const played = muteRegionsOverlapping(
    clip.mute_regions,
    clip.source_start,
    clip.source_end,
  );
  const locked = !editable || busy;

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

  const join = async (mode: string, length: number | null) => {
    if (busy || leftClipId === null) return;
    cancelClipPlacement();
    await run(() =>
      setClipJoin(projectPath, leftClipId, clip.id, mode, length),
    );
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

  const fadeField = (which: "in" | "out") => {
    const atCut = which === "in" ? cutIn : cutOut;
    return (
      <ScrubField
        label={which === "in" ? "Fade in" : "Fade out"}
        value={which === "in" ? clip.fade_in_ms : clip.fade_out_ms}
        unit="ms"
        step={CLIP_HANDLE_STEPS.fade.small}
        decimals={0}
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
  const joinNote = joinRenderNote(clip);
  const joinSec = clip.timeline_start;
  return [
    {
      id: "clip",
      rows: [
        { id: "in", label: "Source start", control: edge("in") },
        { id: "out", label: "Source end", control: edge("out") },
        { id: "fadeIn", label: "Fade in", control: fadeField("in") },
        { id: "fadeOut", label: "Fade out", control: fadeField("out") },
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
          : []),
        ...(leftClipId === null
          ? []
          : [
              {
                id: "join",
                label: "Incoming transition",
                control: editable ? (
                  <select
                    value={clip.join_in_mode}
                    disabled={busy}
                    aria-label="Incoming transition"
                    title={capabilityTooltip("daw.edit.setClipJoin")}
                    onChange={(e) => void join(e.target.value, null)}
                  >
                    {JOIN_MODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  joinModeLabel(clip.join_in_mode)
                ),
              },
              ...(cutIn || !editable
                ? []
                : [
                    {
                      id: "joinLength",
                      label: "Transition length",
                      control: (
                        <ScrubField
                          label="Transition length"
                          value={null}
                          unit="ms"
                          decimals={0}
                          stepsFromEmpty={false}
                          min={clip.join_in_mode === "crossfade" ? 1 : 0}
                          readOnly={locked}
                          onCommit={(value) =>
                            void join(clip.join_in_mode, value)
                          }
                        />
                      ),
                    },
                  ]),
              {
                id: "joinNote",
                control: note(
                  [
                    "Controls the incoming join from the previous clip into this one.",
                    joinNote,
                  ]
                    .filter(Boolean)
                    .join(" "),
                  "status",
                ),
              },
            ]),
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
        {
          id: "bleed",
          label: "Auto reduction",
          control: (
            <Button
              disabledReason={busy ? BUSY_REASON : undefined}
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
        {
          id: "move",
          label: "Move",
          control: <ClipPlacementControls clipId={clip.id} busy={busy} />,
        },
        ...(error
          ? [
              {
                id: "error",
                control: (
                  <p className="sys-inspector-note" role="alert">
                    {error}
                  </p>
                ),
              },
            ]
          : []),
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
                  <>
                    <Button
                      variant="danger"
                      disabledReason={busy ? BUSY_REASON : undefined}
                      onClick={() => void ripple()}
                    >
                      {commandLabel("edit.rippleDelete", "short")}
                    </Button>
                    {note(
                      "Cut on the bar leaves a gap. Ripple delete closes it on every dialogue track.",
                    )}
                  </>
                ),
              },
            ]
          : []),
      ],
    },
  ];
}
