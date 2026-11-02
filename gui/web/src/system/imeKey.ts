import type { KeyboardEvent } from "react";

const IME_KEYCODE = 229;

/** True for the key that commits an IME composition. Some browsers send keyCode 229 without isComposing. */
export function isImeKey(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === IME_KEYCODE;
}
