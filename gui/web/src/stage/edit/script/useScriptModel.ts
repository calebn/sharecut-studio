import { useMemo } from "react";
import { useDawStore } from "../../../state/dawStore";
import {
  NO_BOUNDARIES,
  NO_PENDING,
  NO_TRACKS,
  NO_UTTERANCES,
  personOf,
  type ScriptHostModel,
  scriptHostModelOf,
} from "./scriptHostModel";

export type { ScriptHostModel };

/**
 * The project's transcript as the Script pane's model. One field per store
 * read, and the model is rebuilt only when the utterances, cuts, suggestions
 * or tracks change, never on a playhead tick.
 */
export function useScriptModel(): ScriptHostModel {
  const utterances =
    useDawStore((s) => s.project?.transcript?.utterances) ?? NO_UTTERANCES;
  const boundaries =
    useDawStore((s) => s.project?.edit_boundaries) ?? NO_BOUNDARIES;
  const pending = useDawStore((s) => s.project?.pending_edits) ?? NO_PENDING;
  const tracks = useDawStore((s) => s.project?.tracks) ?? NO_TRACKS;

  return useMemo(
    () =>
      scriptHostModelOf(
        { utterances, boundaries, pending, tracks },
        personOf(tracks),
      ),
    [utterances, boundaries, pending, tracks],
  );
}
