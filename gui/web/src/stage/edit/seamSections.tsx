import { useEffect, useState } from "react";
import { setSeamJoin } from "../../commands/seamCommands";
import { clampClipFades } from "../../edit/fadeLimits";
import {
  appliedJoinLength,
  joinRenderNote,
  projectJoinDraft,
} from "../../edit/joinRender";
import { type Seam, seamById, seamTitle } from "../../edit/seam";
import { canApplyPass12 } from "../../shareMode";
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
import { note } from "./sheetNote";
import { useSeamReplay } from "./useSeamReplay";

export const MAX_JOIN_LENGTH_MS = 500;

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
  const [error, setError] = useState<string | null>(null);
  const replay = useSeamReplay();
  const seamId = selection?.kind === "seam" ? selection.id : null;
  const seam = project && seamId ? seamById(project, seamId) : null;
  const rightId = seam?.right.id ?? null;

  useEffect(() => {
    setDraftMs(null);
    setError(null);
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
        ...(error
          ? [{ id: "error", control: <InlineError message={error} /> }]
          : []),
      ],
    },
  ];
}
