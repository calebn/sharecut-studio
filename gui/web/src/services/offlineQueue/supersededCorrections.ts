import { shareTokenFromKey } from "../../shareMode";
import { DocumentCommand } from "../../types/documentCommands.generated";
import {
  type OfflineConflict,
  removeConflictsWhere,
  removeHostConflictsWhere,
} from "./offlineStore";

/** First word index a transcript correction payload rewrites. */
function correctionStart(payload: Record<string, unknown>): unknown {
  return payload.word_index ?? payload.start_word_index;
}

function isTranscriptCorrection(type: string): boolean {
  return (
    type === DocumentCommand.CorrectTranscriptWord ||
    type === DocumentCommand.CorrectTranscriptPhrase
  );
}

/**
 * After a transcript correction lands, live (services/commandQueue.ts) or
 * replayed from the offline queue (drainOfflineQueue.ts replayQueuedCommands),
 * drop Needs attention entries for earlier refused corrections of the same word
 * (same track and start index), so the banner stops asking the user to redo a
 * correction that has now been made (#746); a no-op for any other command
 * type. A failed cleanup never fails the correction; Dismiss all still clears
 * it.
 */
export async function clearSupersededCorrectionConflicts(
  projectPath: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isTranscriptCorrection(type)) {
    return;
  }
  const superseded = ({ command }: OfflineConflict) =>
    isTranscriptCorrection(command.type) &&
    command.payload.track_id === payload.track_id &&
    command.payload.source_id === payload.source_id &&
    correctionStart(command.payload) === correctionStart(payload);
  const token = shareTokenFromKey(projectPath);
  try {
    await (token
      ? removeConflictsWhere(token, superseded)
      : removeHostConflictsWhere(projectPath, superseded));
  } catch {
    // Leave the entry; Dismiss all clears it.
  }
}
