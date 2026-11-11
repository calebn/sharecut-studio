import {
  PLAY_DENIED_REASON,
  runRangeAction,
} from "../../commands/rangeActions";
import { makeRangeTarget } from "../../edit/rangeSelection";
import { cutSpan, suggestionOf } from "../../review/conflictRows";
import type { ReviewAttention } from "../../review/reviewQueueModel";
import {
  activeConflictIds,
  conflictByCommandId,
  dismissOneConflict,
  hasConflictBeyond,
} from "../../services/offlineQueue/offlineAttention";
import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";
import { hasShareCapability } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { playTimelineRange } from "../../utils/playRange";
import { formatTimeShort } from "../../utils/time";

const HEAR_PAD_SEC = 2;

const NOT_LISTED = "That suggestion is no longer listed";
const AUDIO_GONE =
  "That part of the audio is gone, so there is nothing to suggest again";
const PROJECT_NOT_OPEN = "Open the project to suggest it again";
const HEAR_NEEDS_PROJECT = "Open the project to hear it";
const NOT_CONFIRMED =
  "Could not confirm the new suggestion was sent. Check the list before suggesting again.";
const OLD_ROW_STAYS =
  "Suggested again, but the old row could not be cleared. Drop it to remove it.";

type Span = { startSec: number; endSec: number; trackIds: readonly string[] };

const refusedAgain = (span: Span) => (conflict: OfflineConflict) => {
  const found = cutSpan(conflict.command.payload);
  return (
    found !== undefined &&
    found.startSec === span.startSec &&
    found.endSec === span.endSec &&
    found.trackIds.length === span.trackIds.length &&
    found.trackIds.every((id) => span.trackIds.includes(id))
  );
};

type Actions = NonNullable<ReviewAttention["suggestionActions"]>;
type Row = Pick<Parameters<Actions["onDrop"]>[0], "id">;

const working = new Set<string>();

const tell = (message: string) =>
  useDawStore.getState().announceStatus(message, { tone: "error" });

/**
 * What a guest's conflict row buttons do. Each looks the conflict up by row id when it is
 * clicked: the 2 s read may have changed or removed the row since it was drawn.
 */
export function conflictRowActions(projectPath: string): Actions {
  const resolve = (row: Row) => {
    const conflict = conflictByCommandId(projectPath, row.id);
    const suggestion = conflict && suggestionOf(conflict);
    if (!conflict || !suggestion) {
      tell(NOT_LISTED);
      return undefined;
    }
    return { conflict, suggestion };
  };
  const once = async (row: Row, run: () => Promise<void>) => {
    const key = `${projectPath}\u0000${row.id}`;
    if (working.has(key)) return;
    working.add(key);
    try {
      await run();
    } finally {
      working.delete(key);
    }
  };

  return {
    onHear: (row) => {
      const found = resolve(row);
      if (!found) return;
      const state = useDawStore.getState();
      if (!hasShareCapability(state.shareCapabilities, "play")) {
        tell(PLAY_DENIED_REASON);
        return;
      }
      if (!state.project) {
        tell(HEAR_NEEDS_PROJECT);
        return;
      }
      playTimelineRange({
        start: found.suggestion.startSec,
        end: found.suggestion.endSec,
        padSec: HEAR_PAD_SEC,
        beginAudition: state.beginAudition,
        setPlayheadSec: state.setPlayheadSec,
        setPlayUntilSec: state.setPlayUntilSec,
        setIsPlaying: state.setIsPlaying,
      });
    },
    onDrop: (row) =>
      once(row, async () => {
        const found = resolve(row);
        if (!found) return;
        const at = formatTimeShort(found.suggestion.startSec);
        if (await dismissOneConflict(projectPath, found.conflict)) {
          useDawStore.getState().announceStatus(`Dropped your cut at ${at}`);
        } else {
          tell("Could not drop your cut. Try again.");
        }
      }),
    onSuggestAgain: (row) =>
      once(row, async () => {
        const found = resolve(row);
        if (!found) return;
        const { project } = useDawStore.getState();
        if (!project) {
          tell(PROJECT_NOT_OPEN);
          return;
        }
        const { startSec, endSec, trackIds } = found.suggestion;
        const target = makeRangeTarget(
          project,
          [{ start: startSec, end: endSec }],
          trackIds,
        );
        if (!target) {
          tell(AUDIO_GONE);
          return;
        }
        const known = activeConflictIds(projectPath);
        const result = await runRangeAction("cut", target);
        if (result.status === "disabled" && !result.told) tell(result.reason);
        let admitted = result.status === "ok";
        if (result.status === "disabled" && result.told === true) {
          try {
            admitted = await hasConflictBeyond(
              projectPath,
              known,
              refusedAgain({ startSec, endSec, trackIds }),
            );
          } catch {
            tell(NOT_CONFIRMED);
            return;
          }
        }
        if (!admitted) return;
        if (!(await dismissOneConflict(projectPath, found.conflict)))
          tell(OLD_ROW_STAYS);
      }),
  };
}
