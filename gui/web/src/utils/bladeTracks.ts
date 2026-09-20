/** Resolve which tracks a blade cut should target. */
export function bladeTrackIds(
  selectedTrackIds: string[],
  dialogueTrackIds: string[],
): string[] {
  if (selectedTrackIds.length > 0) {
    return selectedTrackIds;
  }
  return dialogueTrackIds;
}
