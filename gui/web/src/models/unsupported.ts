/** Said when the server marks a tool or model unsupported without a sentence. It is the server's own wording for audio tools. */
export const NOT_ON_THIS_DEVICE =
  "ShareCut can't process audio on this device yet.";

export function unsupportedSentence(hint: string | null | undefined): string {
  return hint ? hint : NOT_ON_THIS_DEVICE;
}

export const TOOLS_MISSING_DESKTOP_DETAIL =
  "Download ShareCut Studio again from where you got it, replace this copy, then reopen it. Your episodes are not affected.";

export const TOOLS_MISSING_REINSTALL_DETAIL =
  "Reinstall ShareCut Studio to restore them.";
