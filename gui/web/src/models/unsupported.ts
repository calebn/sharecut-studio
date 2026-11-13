/** Said when the server marks a tool or model unsupported without a sentence of its own. */
export const NOT_ON_THIS_DEVICE =
  "Audio tools aren't available on this device yet.";

export function unsupportedSentence(hint: string | null | undefined): string {
  return hint ? hint : NOT_ON_THIS_DEVICE;
}
