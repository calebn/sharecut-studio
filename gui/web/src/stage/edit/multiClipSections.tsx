import { setClipsFade, setClipsGain } from "../../api";
import { CLIP_HANDLE_STEPS } from "../../edit/clipHandleSteps";
import { cancelClipPlacement } from "../../edit/clipPlacement";
import { clampClipFades, maxFadeMs } from "../../edit/fadeLimits";
import { clipIdsBeforeCut, isCutJoin } from "../../edit/joinRender";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import type { ClipRow, ProjectView } from "../../types/project";
import {
  CLIP_GAIN_MAX_DB,
  CLIP_GAIN_MIN_DB,
  CLIP_GAIN_STEP_DB,
  clampClipGainDb,
  clipGainDb,
} from "../../utils/audio";
import { note } from "./sheetNote";

type Edge = "in" | "out";

const fadeOf = (clip: ClipRow, edge: Edge) =>
  edge === "in" ? clip.fade_in_ms : clip.fade_out_ms;

export function multiClipSections({
  project,
  clipIds,
  projectPath,
  locked,
  error,
  run,
}: {
  project: ProjectView | null;
  clipIds: readonly string[];
  projectPath: string;
  locked: boolean;
  error: string | null;
  run: (fn: () => Promise<unknown>) => Promise<unknown>;
}): readonly InspectorSection[] {
  const wanted = new Set(clipIds);
  const clips = Object.values(project?.clips.tracks ?? {})
    .flat()
    .filter((clip) => wanted.has(clip.id));
  if (clips.length === 0)
    return [
      { id: "gone", rows: [{ id: "gone", control: note("Clips not found") }] },
    ];
  const cutOut = new Set(
    Object.values(project?.clips.tracks ?? {}).flatMap((lane) => [
      ...clipIdsBeforeCut(lane),
    ]),
  );
  const capOf = (clip: ClipRow) =>
    project?.tracks.find((t) => t.id === clip.track_id)?.fade_max_ms;
  const capKnown = clips.every((clip) => capOf(clip) !== undefined);
  const secOf = (clip: ClipRow) => clip.source_end - clip.source_start;

  const field = (edge: Edge) => {
    const reach = clips.filter((clip) =>
      edge === "in" ? !isCutJoin(clip) : !cutOut.has(clip.id),
    );
    const values = new Set(reach.map((clip) => fadeOf(clip, edge)));
    const common = values.size === 1 ? [...values][0] : null;
    const ceiling = Math.max(
      0,
      ...reach.map((clip) => maxFadeMs(secOf(clip), capOf(clip))),
    );
    const apply = (value: number) => {
      const delta = value - (common ?? 0);
      const fades = reach.flatMap((clip) => {
        const next = clampClipFades(
          clip.fade_in_ms + (edge === "in" ? delta : 0),
          clip.fade_out_ms + (edge === "out" ? delta : 0),
          secOf(clip),
          capOf(clip),
        );
        return next.inMs === clip.fade_in_ms && next.outMs === clip.fade_out_ms
          ? []
          : [
              {
                clip_id: clip.id,
                fade_in_ms: next.inMs,
                fade_out_ms: next.outMs,
                expected: {
                  fade_in_ms: clip.fade_in_ms,
                  fade_out_ms: clip.fade_out_ms,
                },
              },
            ];
      });
      if (fades.length === 0) return;
      cancelClipPlacement();
      void run(() => setClipsFade(projectPath, fades));
    };
    return (
      <ScrubField
        label={edge === "in" ? "Fade in" : "Fade out"}
        value={common}
        emptyText="Mixed"
        defaultValue={common === null ? 0 : undefined}
        unit="ms"
        step={CLIP_HANDLE_STEPS.fade.small}
        decimals={0}
        integerOnly
        min={common === null ? -ceiling : 0}
        max={ceiling}
        readOnly={locked || !capKnown || reach.length === 0}
        onCommit={apply}
      />
    );
  };

  const gainValues = new Set(clips.map(clipGainDb));
  const commonGain = gainValues.size === 1 ? [...gainValues][0]! : null;
  const applyGain = (value: number) => {
    const target = clampClipGainDb(value);
    const gains = clips.flatMap((clip) =>
      clipGainDb(clip) === target
        ? []
        : [
            {
              clip_id: clip.id,
              gain_db: target,
              expected: { gain_db: clipGainDb(clip) },
            },
          ],
    );
    if (gains.length === 0) return;
    cancelClipPlacement();
    void run(() => setClipsGain(projectPath, gains));
  };
  const gainField = (
    <ScrubField
      variant="level"
      label="Gain"
      value={commonGain}
      emptyText="Mixed"
      unit="dB"
      min={CLIP_GAIN_MIN_DB}
      max={CLIP_GAIN_MAX_DB}
      step={CLIP_GAIN_STEP_DB}
      defaultValue={0}
      readOnly={locked}
      onCommit={applyGain}
    />
  );

  return [
    {
      id: "clip",
      rows: [
        { id: "fadeIn", label: "Fade in", control: field("in") },
        { id: "fadeOut", label: "Fade out", control: field("out") },
        { id: "gain", label: "Gain", control: gainField },
        ...(locked
          ? []
          : [
              {
                id: "fadeNote",
                control: note(
                  "A fade changes by the amount you scrub; Gain sets every selected clip to the level you choose.",
                  "status",
                ),
              },
            ]),
        ...(error ? [{ id: "error", control: note(error, "alert") }] : []),
      ],
    },
  ];
}
