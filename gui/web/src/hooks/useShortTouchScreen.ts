import { SHORT_SCREEN_MQ } from "../layout/useCompactInspector";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

/**
 * A touch screen at most 40rem tall: a phone held sideways. It reads the
 * primary pointer's capability, like the touch shell CSS, not the last pointer
 * used, so a first touch never resizes the lanes under the finger.
 */
const SHORT_TOUCH_MQ = `${SHORT_SCREEN_MQ} and (pointer: coarse)`;

const subscribe = mediaQuerySubscription([SHORT_TOUCH_MQ]);
const read = () =>
  typeof globalThis.matchMedia === "function" &&
  globalThis.matchMedia(SHORT_TOUCH_MQ).matches;

/** True on a short touch screen; compact lanes (#1077) follow it. */
export function useShortTouchScreen(): boolean {
  return useMediaQueryStore(subscribe, read, () => false);
}
