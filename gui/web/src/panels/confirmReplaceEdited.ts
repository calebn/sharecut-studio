import { askConfirm } from "../feedback/ask";
import { useDawStore } from "../state/dawStore";

/**
 * Ask before `action` replaces hand-edited transcripts on `edited` track ids.
 * null = kept; true = replace them; false = none are edited.
 */
export async function confirmReplaceEdited(
  edited: readonly string[],
  action: string,
): Promise<boolean | null> {
  if (edited.length === 0) {
    return false;
  }
  const tracks = useDawStore.getState().project?.tracks ?? [];
  const names = edited.map(
    (id) => tracks.find((t) => t.id === id)?.label || id,
  );
  const plural = names.length > 1;
  const replaced = await askConfirm({
    title: plural
      ? "Replace your transcript edits?"
      : "Replace your transcript edit?",
    message: `${action} replaces the hand-edited ${plural ? "transcripts" : "transcript"} on ${names.join(", ")}.`,
    keepLabel: "Keep my edits",
    actionLabel: `Replace ${plural ? "transcripts" : "transcript"}`,
    danger: true,
  });
  return replaced ? true : null;
}
