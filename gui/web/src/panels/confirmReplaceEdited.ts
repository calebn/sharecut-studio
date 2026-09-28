/**
 * Ask before `action` replaces hand-edited transcripts.
 * null = cancelled; true = replace them; false = none are edited.
 */
export function confirmReplaceEdited(
  edited: readonly string[],
  action: string,
): boolean | null {
  if (edited.length === 0) {
    return false;
  }
  const count =
    edited.length === 1 ? "1 track has" : `${edited.length} tracks have`;
  return window.confirm(
    `${count} hand-edited transcripts that ${action} will replace: ${edited.join(", ")}. Replace them?`,
  )
    ? true
    : null;
}
