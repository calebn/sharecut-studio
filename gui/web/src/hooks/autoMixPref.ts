/** Browser preference that pauses the automatic mix rebuild (`"off"`); the manual command still works. */
export const AUTO_MIX_PREF_KEY = "sharecut.autoMix";

export function autoMixPaused(): boolean {
  try {
    return window.localStorage.getItem(AUTO_MIX_PREF_KEY) === "off";
  } catch {
    return false;
  }
}
