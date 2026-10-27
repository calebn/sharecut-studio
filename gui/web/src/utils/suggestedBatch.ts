import type { HistoryGroup, ProjectView } from "../types/project";

/** The actions a sound can have; the server's `SUGGESTED_ACTIONS` (`edits/cut_policy.py`). */
export const SOUND_ACTIONS = ["cut", "shorten", "lower", "leave"] as const;

export type SoundAction = (typeof SOUND_ACTIONS)[number];

export const SOUND_ACTION_LABEL: Record<SoundAction, string> = {
  cut: "Cut",
  shorten: "Shorten",
  lower: "Lower",
  leave: "Leave",
};

/** One sound of the batch Apply suggested actions just ran. */
export type SuggestedBatchSound = {
  id: string;
  label: string;
  trackId: string;
  timelineStart: number | null;
  action: SoundAction;
};

const BATCH_OPERATION = "apply_suggested_actions";
// A preview render lands after an edit without changing it.
const IGNORED_OPERATION = "render_preview";

export function isSoundAction(value: unknown): value is SoundAction {
  return SOUND_ACTIONS.some((action) => action === value);
}

function groupEnd(group: HistoryGroup): number | undefined {
  return group.after_index ?? group.index;
}

function soundFrom(row: unknown): SuggestedBatchSound | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const { id, label, track_id, timeline_start, action } = row as Record<
    string,
    unknown
  >;
  if (
    typeof id !== "string" ||
    typeof label !== "string" ||
    typeof track_id !== "string" ||
    !isSoundAction(action)
  ) {
    return null;
  }
  return {
    id,
    label,
    trackId: track_id,
    timelineStart: typeof timeline_start === "number" ? timeline_start : null,
    action,
  };
}

/**
 * The sounds of the Apply suggested actions batch the server can still revise: the batch
 * must be the latest edit (the server refuses otherwise), and a sound that stayed pending
 * (a held cut) is left out because the Tighten list already shows it.
 */
export function revisableSuggestedBatch(
  project: Pick<ProjectView, "history" | "pending_edits">,
): SuggestedBatchSound[] {
  const { groups, cursor } = project.history;
  const latest = [...groups]
    .reverse()
    .find((group) => group.operation !== IGNORED_OPERATION);
  if (!latest || latest.operation !== BATCH_OPERATION) {
    return [];
  }
  const last = groups[groups.length - 1];
  if (!last || groupEnd(last) !== cursor) {
    return [];
  }
  const rows = latest.params?.sounds;
  if (!Array.isArray(rows)) {
    return [];
  }
  const pending = new Set(project.pending_edits.map((edit) => edit.id));
  return rows
    .map(soundFrom)
    .filter(
      (sound): sound is SuggestedBatchSound =>
        sound !== null && !pending.has(sound.id),
    );
}
