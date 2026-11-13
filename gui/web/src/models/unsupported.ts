/** Said when the server marks a tool or model unsupported without a sentence. It is the server's own wording for audio tools. */
export const NOT_ON_THIS_DEVICE =
  "ShareCut can't process audio on this device yet.";

export function unsupportedSentence(hint: string | null | undefined): string {
  return hint ? hint : NOT_ON_THIS_DEVICE;
}
