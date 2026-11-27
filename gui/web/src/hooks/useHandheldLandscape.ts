import { COARSE_POINTER_MQ, readHandheld } from "../utils/handheldScreen";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

const subscribe = mediaQuerySubscription([COARSE_POINTER_MQ], (onChange) => {
  window.addEventListener("resize", onChange);
  window.addEventListener("orientationchange", onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    window.removeEventListener("orientationchange", onChange);
  };
});

/**
 * True on a handheld phone held either way; the Listen layout follows it.
 * Only `useShellAttributes` subscribes: it publishes the value to the store
 * (`handheldLandscape`), and every other reader takes it from there.
 */
export function useHandheldLandscape(): boolean {
  return useMediaQueryStore(subscribe, readHandheld, () => false);
}
