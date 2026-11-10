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
import { joinTypeChoices, joinTypeLabel } from "../../edit/joinType";
import { type RollJoinInterval, rollJoinInterval } from "../../edit/rollLimits";
import { type Seam, seamById } from "../../edit/seam";
import { canApplyPass12 } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { InspectorSection } from "../../system/InspectorSheet";
import type { SystemIconName } from "../../system/icons";
import { ScrubField } from "../../system/ScrubField";
import { SystemIcon } from "../../system/SystemIcon";
import type { JoinMode, ProjectView } from "../../types/project";
import { SegmentedControl, ToggleButton } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { joinModeOf } from "../../utils/editMarkerRegistry";
import { note } from "./sheetNote";
import { useSeamReplay } from "./useSeamReplay";

type Rows = InspectorSection["rows"];

const MAX_JOIN_LENGTH_MS = 500;
const NO_ROOM_NOTE = "The clips leave no room to roll";
const NOT_TOUCHING_NOTE = "The clips do not touch";

const CROSSFADE_BLOCKED_REASON: Record<string, string> = {
  not_abutting: "the clips do not touch",
  no_fade_out: "the left clip has no fade-out",
  no_fade_in: "this clip has no fade-in",
  no_headroom: "the recordings have no room past the cut to overlap",
};

const JOIN_TYPE_ICON = {
  cut: "minus",
  fade: "fade",
  crossfade: "crossfade",
} as const satisfies Record<JoinMode, SystemIconName>;

const SCOPE_NAME = { start: "Start join", end: "End join" } as const;

export type SeamJoinScope = keyof typeof SCOPE_NAME;

export type SeamJoinFields = {
  seam: Seam;
  project: ProjectView;
  scope: SeamJoinScope | null;
  editable: boolean;
  busy: boolean;
  mode: JoinMode;
  interval: RollJoinInterval | null;
  originEnd: number;
  sinceOpenSec: number;
  error: string | null;
  supersede: () => void;
  setType: (mode: JoinMode) => Promise<void>;
  length: {
    range: ReturnType<typeof appliedJoinLength>;
    max: number;
    crossfade: boolean;
    draft: number | null;
    reducedOut: number;
    blocked: string | null;
    preview: (value: number) => void;
    commit: (value: number) => Promise<void>;
    cancel: () => void;
  };
  offset: {
    valueMs: number;
    draftMs: number | null;
    roomToRoll: boolean;
    preview: (value: number) => void;
    commit: (value: number) => Promise<void>;
    cancel: () => void;
  };
};

const named = (f: SeamJoinFields, label: string) =>
  f.scope ? `${SCOPE_NAME[f.scope]} ${label.toLowerCase()}` : label;
const rowId = (f: SeamJoinFields, id: string) =>
  f.scope ? `${f.scope}-${id}` : id;

export function useSeamJoinFields(
  seamId: string | null,
  scope: SeamJoinScope | null = null,
): SeamJoinFields | null {
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
  const seam = project && seamId ? seamById(project, seamId) : null;
  const rightId = seam?.right.id ?? null;

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

  if (!seam || !project) return null;

  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const { left, right } = seam;
  const mode = joinModeOf(right);
  const fadeMax =
    project.tracks.find((t) => t.id === seam.trackId)?.fade_max_ms ?? null;
  const range = appliedJoinLength(left, right, fadeMax);
  const max = Math.min(MAX_JOIN_LENGTH_MS, range.max);
  const crossfade = mode === "crossfade";
  const draft = crossfade ? draftMs : null;
  const reducedOut =
    draft !== null
      ? clampClipFades(
          draft,
          right.fade_out_ms,
          right.source_end - right.source_start,
          fadeMax,
        ).outMs
      : right.fade_out_ms;
  const blocked = right.join_crossfade_blocked
    ? (CROSSFADE_BLOCKED_REASON[right.join_crossfade_blocked] ??
      right.join_crossfade_blocked)
    : null;
  const interval = rollJoinInterval(
    project.clips.tracks[seam.trackId] ?? [],
    left.id,
    right.id,
  );
  const originEnd = origin?.id === seam.id ? origin.end : left.source_end;
  const sinceOpenSec = left.source_end - originEnd;
  const offsetMs = Math.round(sinceOpenSec * 1e6) / 1e3;

  const clearDraft = () => {
    setDraftMs(null);
    const live = useDawStore.getState();
    if (live.joinDraft?.id === right.id) live.setJoinDraft(null);
  };
  const settle = (result: Awaited<ReturnType<typeof setSeamJoin>>) => {
    if (result.status === "failed") setError(result.message);
  };
  const setType = async (next: JoinMode) => {
    setError(null);
    settle(await replay.commit(seam.id, () => setSeamJoin(seam, next, null)));
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
    settle(await replay.commit(seam.id, () => setSeamJoin(seam, mode, value)));
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
    const deltaMs =
      (originEnd + value / 1000 - snapshot.left.source_end) * 1000;
    const result = await replay.commit(seam.id, () =>
      rollSeam(snapshot, deltaMs),
    );
    if (result.status === "failed") setError(result.message);
    else if (result.status === "queued") setError(ROLL_QUEUED_MESSAGE);
    else if (result.status === "skipped")
      setError(rollSkipMessage(snapshot, deltaMs));
  };

  return {
    seam,
    project,
    scope,
    editable,
    busy,
    mode,
    interval,
    originEnd,
    sinceOpenSec,
    error,
    supersede: replay.supersede,
    setType,
    length: {
      range,
      max,
      crossfade,
      draft,
      reducedOut,
      blocked,
      preview,
      commit,
      cancel: clearDraft,
    },
    offset: {
      valueMs: offsetMs,
      draftMs: draftOffsetMs,
      roomToRoll: interval !== null && interval.hi > interval.lo,
      preview: previewOffset,
      commit: commitOffset,
      cancel: clearOffsetDraft,
    },
  };
}

export function joinTypeRows(f: SeamJoinFields): Rows {
  if (!f.scope) return [];
  const label = SCOPE_NAME[f.scope];
  const id = rowId(f, "type");
  if (!f.editable) return [{ id, label, control: joinTypeLabel(f.mode) }];
  return [
    {
      id,
      label,
      control: (
        <SegmentedControl label={label}>
          {joinTypeChoices(f.seam, f.project).map((option) => (
            <ToggleButton
              key={option.value}
              quiet
              pressed={option.value === f.mode}
              title={option.label}
              aria-label={option.label}
              disabledReason={f.busy ? BUSY_REASON : undefined}
              onClick={() => void f.setType(option.value)}
            >
              <SystemIcon name={JOIN_TYPE_ICON[option.value]} size={16} />
            </ToggleButton>
          ))}
        </SegmentedControl>
      ),
    },
  ];
}

export function joinLengthRows(f: SeamJoinFields): Rows {
  const { range, max, crossfade, draft, reducedOut, blocked } = f.length;
  const { left, right } = f.seam;
  const notes = [
    draft !== null && !right.join_crossfade_blocked
      ? `Draft overlap ${projectJoinDraft(left, right, draft).join_crossfade_ms ?? 0} ms.`
      : joinRenderNote(right),
    blocked && !crossfade ? `Crossfade is off here: ${blocked}.` : null,
  ].filter((line): line is string => !!line);
  const label = named(f, "Length");
  return [
    ...(f.mode === "cut" || max < range.min
      ? []
      : [
          {
            id: rowId(f, "length"),
            label,
            control: (
              <ScrubField
                label={label}
                value={draft ?? range.saved}
                unit="ms"
                step={1}
                decimals={0}
                integerOnly
                min={range.min}
                max={max}
                readOnly={!f.editable || f.busy}
                onPreview={f.length.preview}
                onCommit={(value) => void f.length.commit(value)}
                onCancel={f.length.cancel}
              />
            ),
          },
        ]),
    ...(notes.length
      ? [
          {
            id: rowId(f, "notes"),
            control: note(notes.join(" "), "status"),
          },
        ]
      : []),
    ...(draft !== null && reducedOut < right.fade_out_ms
      ? [
          {
            id: rowId(f, "fadeWarning"),
            control: note(
              `This length also reduces the right clip fade-out to ${reducedOut} ms.`,
              "status",
            ),
          },
        ]
      : []),
  ];
}

export function joinOffsetRows(f: SeamJoinFields): Rows {
  if (!f.interval) {
    return [{ id: rowId(f, "offsetNote"), control: note(NOT_TOUCHING_NOTE) }];
  }
  const { interval } = f;
  const { valueMs, draftMs, roomToRoll } = f.offset;
  const label = named(f, "Offset");
  return [
    {
      id: rowId(f, "offset"),
      label,
      control: (
        <ScrubField
          label={label}
          value={draftMs ?? valueMs}
          unit="ms"
          step={1}
          decimals={1}
          min={valueMs + interval.lo * 1000}
          max={valueMs + interval.hi * 1000}
          defaultValue={0}
          readOnly={!f.editable || f.busy || !roomToRoll}
          onPreview={f.offset.preview}
          onCommit={(value) => void f.offset.commit(value)}
          onCancel={f.offset.cancel}
        />
      ),
    },
    ...(roomToRoll
      ? []
      : [{ id: rowId(f, "offsetNote"), control: note(NO_ROOM_NOTE) }]),
  ];
}
