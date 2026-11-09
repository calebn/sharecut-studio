import { useEffect, useRef, useState } from "react";
import {
  ROLL_QUEUED_MESSAGE,
  rollSeam,
  rollSkipMessage,
  setSeamJoin,
} from "../../commands/seamCommands";
import { clampClipFades } from "../../edit/fadeLimits";
import {
  appliedJoinLength,
  joinRenderNote,
  projectJoinDraft,
} from "../../edit/joinRender";
import { rollJoinInterval } from "../../edit/rollLimits";
import { type Seam, seamById, seamTitle } from "../../edit/seam";
import { canApplyPass12, canHostMutate } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import { ScrubField } from "../../system/ScrubField";
import { appliedEditTitle } from "../../timeline/appliedEditTicks";
import type { Selection } from "../../types/project";
import { InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { joinModeOf } from "../../utils/editMarkerRegistry";
import { relativeTime } from "../../utils/relativeTime";
import { SeamAbRow } from "./SeamAbRow";
import { note } from "./sheetNote";
import { AB_CLAMPED_REASON, useSeamAudition } from "./useSeamAudition";
import { useSeamReplay } from "./useSeamReplay";

export const MAX_JOIN_LENGTH_MS = 500;
const NO_ROOM_NOTE = "The clips leave no room to roll";
const NOT_TOUCHING_NOTE = "The clips do not touch";
const AB_GUEST_REASON = "A/B needs the host app";
const AB_UNROLLED_REASON = "Roll the seam to compare";
const AB_BUSY_REASON = "A/B is ready once the roll saves";
const ROLLED_EPS_SEC = 1e-9;

const CROSSFADE_BLOCKED_REASON: Record<string, string> = {
  not_abutting: "the clips do not touch",
  no_fade_out: "the left clip has no fade-out",
  no_fade_in: "this clip has no fade-in",
  no_headroom: "the recordings have no room past the cut to overlap",
};

function appliedByLine(seam: Extract<Seam, { kind: "cut" }>): string | null {
  const first = seam.records[0];
  if (!first) return null;
  const more = seam.records.length - 1;
  const age = relativeTime(first.applied_at, new Date());
  return `${appliedEditTitle(first)} · applied ${age}${more > 0 ? ` · +${more} more` : ""}`;
}

export function useSeamSections(
  selection: Selection,
): readonly InspectorSection[] | null {
  const { project, projectPath, guestMode, shareCapabilities, busy } = useDaw(
    (s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      busy: s.joinMutationInFlight,
    }),
  );
  const [draftMs, setDraftMs] = useState<number | null>(null);
  const [draftOffsetMs, setDraftOffsetMs] = useState<number | null>(null);
  const [origin, setOrigin] = useState<{ id: string; end: number } | null>(
    null,
  );
  const gesture = useRef<Seam | null>(null);
  const [error, setError] = useState<string | null>(null);
  const replay = useSeamReplay();
  const seamId = selection?.kind === "seam" ? selection.id : null;
  const seam = project && seamId ? seamById(project, seamId) : null;
  const rightId = seam?.right.id ?? null;
  const originEnd =
    seam && origin?.id === seam.id
      ? origin.end
      : (seam?.left.source_end ?? null);
  const audition = useSeamAudition(seam, originEnd);

  useEffect(() => {
    setDraftMs(null);
    setDraftOffsetMs(null);
    setError(null);
    gesture.current = null;
    const live = useDawStore.getState();
    const opened =
      live.project && seamId ? seamById(live.project, seamId) : null;
    setOrigin(opened ? { id: opened.id, end: opened.left.source_end } : null);
    return () => {
      const live = useDawStore.getState();
      if (live.joinDraft?.id === rightId) live.setJoinDraft(null);
    };
  }, [seamId, rightId]);

  if (selection?.kind !== "seam") return null;
  if (!seam || !project) {
    return [
      { id: "gone", rows: [{ id: "gone", control: note("Seam not found") }] },
    ];
  }

  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const { left, right } = seam;
  const mode = joinModeOf(right);
  const fadeMax =
    project.tracks.find((t) => t.id === seam.trackId)?.fade_max_ms ?? null;
  const range = appliedJoinLength(left, right, fadeMax);
  const max = Math.min(MAX_JOIN_LENGTH_MS, range.max);
  const crossfade = mode === "crossfade";
  const drafting = draftMs !== null && crossfade;
  const reducedOut = drafting
    ? clampClipFades(
        draftMs,
        right.fade_out_ms,
        right.source_end - right.source_start,
        fadeMax,
      ).outMs
    : right.fade_out_ms;
  const blocked = right.join_crossfade_blocked
    ? (CROSSFADE_BLOCKED_REASON[right.join_crossfade_blocked] ??
      right.join_crossfade_blocked)
    : null;
  const appliedBy = seam.kind === "cut" ? appliedByLine(seam) : null;
  const interval = rollJoinInterval(
    project.clips.tracks[seam.trackId] ?? [],
    left.id,
    right.id,
  );
  const openEnd = originEnd ?? left.source_end;
  const sinceOpenSec = left.source_end - openEnd;
  const offsetMs = Math.round(sinceOpenSec * 1e6) / 1e3;
  const abReason = !canHostMutate(projectPath)
    ? AB_GUEST_REASON
    : Math.abs(sinceOpenSec) <= ROLLED_EPS_SEC
      ? AB_UNROLLED_REASON
      : audition.error === AB_CLAMPED_REASON
        ? AB_CLAMPED_REASON
        : busy
          ? AB_BUSY_REASON
          : null;
  const auditionFailure =
    audition.error === AB_CLAMPED_REASON ? null : audition.error;
  const roomToRoll = interval !== null && interval.hi > interval.lo;

  const clearDraft = () => {
    setDraftMs(null);
    const live = useDawStore.getState();
    if (live.joinDraft?.id === right.id) live.setJoinDraft(null);
  };
  const preview = (value: number) => {
    replay.supersede();
    setDraftMs(value);
    if (crossfade) {
      useDawStore.getState().setJoinDraft(projectJoinDraft(left, right, value));
    }
  };
  const commit = async (value: number) => {
    clearDraft();
    setError(null);
    const result = await replay.commit(seam.id, () =>
      setSeamJoin(seam, mode, value),
    );
    if (result.status === "failed") setError(result.message);
  };

  const clearOffsetDraft = () => {
    gesture.current = null;
    setDraftOffsetMs(null);
  };
  const previewOffset = (value: number) => {
    replay.supersede();
    gesture.current ??= seam;
    setDraftOffsetMs(value);
  };
  const commitOffset = async (value: number) => {
    const snapshot = gesture.current ?? seam;
    clearOffsetDraft();
    setError(null);
    const deltaMs = (openEnd + value / 1000 - snapshot.left.source_end) * 1000;
    const result = await replay.commit(seam.id, () =>
      rollSeam(snapshot, deltaMs),
    );
    if (result.status === "failed") setError(result.message);
    else if (result.status === "queued") setError(ROLL_QUEUED_MESSAGE);
    else if (result.status === "skipped") setError(rollSkipMessage(deltaMs));
  };

  const notes = [
    drafting && !right.join_crossfade_blocked
      ? `Draft overlap ${projectJoinDraft(left, right, draftMs).join_crossfade_ms ?? 0} ms.`
      : joinRenderNote(right),
    blocked && !crossfade ? `Crossfade is off here: ${blocked}.` : null,
  ].filter((line): line is string => !!line);

  return [
    {
      id: "seam",
      rows: [
        { id: "title", control: note(seamTitle(seam), "status") },
        ...(appliedBy ? [{ id: "appliedBy", control: note(appliedBy) }] : []),
        ...(interval
          ? [
              {
                id: "offset",
                label: "Offset",
                control: (
                  <ScrubField
                    label="Offset"
                    value={draftOffsetMs ?? offsetMs}
                    unit="ms"
                    step={1}
                    decimals={1}
                    min={offsetMs + interval.lo * 1000}
                    max={offsetMs + interval.hi * 1000}
                    defaultValue={0}
                    readOnly={!editable || busy || !roomToRoll}
                    onPreview={previewOffset}
                    onCommit={(value) => void commitOffset(value)}
                    onCancel={clearOffsetDraft}
                  />
                ),
              },
              ...(roomToRoll
                ? []
                : [{ id: "offsetNote", control: note(NO_ROOM_NOTE) }]),
            ]
          : [{ id: "offsetNote", control: note(NOT_TOUCHING_NOTE) }]),
        ...(interval
          ? [
              {
                id: "ab",
                label: "A/B",
                control: (
                  <SeamAbRow
                    reason={abReason}
                    side={audition.side}
                    pending={audition.pending}
                    joinSec={seam.joinSec}
                    onSelect={(next) => {
                      replay.supersede();
                      audition.play(next);
                    }}
                  />
                ),
              },
            ]
          : []),
        ...(mode === "cut" || max < range.min
          ? []
          : [
              {
                id: "length",
                label: "Length",
                control: (
                  <ScrubField
                    label="Length"
                    value={drafting ? draftMs : range.saved}
                    unit="ms"
                    step={1}
                    decimals={0}
                    integerOnly
                    min={range.min}
                    max={max}
                    readOnly={!editable || busy}
                    onPreview={preview}
                    onCommit={(value) => void commit(value)}
                    onCancel={clearDraft}
                  />
                ),
              },
            ]),
        ...(notes.length
          ? [{ id: "notes", control: note(notes.join(" "), "status") }]
          : []),
        ...(drafting && reducedOut < right.fade_out_ms
          ? [
              {
                id: "fadeWarning",
                control: note(
                  `This length also reduces the right clip fade-out to ${reducedOut} ms.`,
                  "status",
                ),
              },
            ]
          : []),
        ...(editable && busy
          ? [{ id: "busy", control: note(BUSY_REASON, "status") }]
          : []),
        ...((error ?? auditionFailure)
          ? [
              {
                id: "error",
                control: (
                  <InlineError message={error ?? auditionFailure ?? ""} />
                ),
              },
            ]
          : []),
      ],
    },
  ];
}
