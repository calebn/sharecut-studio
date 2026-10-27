import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../../hooks/useMediaQueryStore";
import { SHORT_SCREEN_MQ } from "./useCompactInspector";

/**
 * A phone held sideways with the width for a side column (#1696): a coarse
 * primary pointer, at most 40rem tall and at least 40rem wide. Narrower or
 * taller screens keep the bottom sheet, and a mouse window of that size does
 * too. Like `useShortTouchScreen` it reads the primary pointer's capability,
 * not the last pointer used.
 */
const INSPECTOR_COLUMN_MQ = `${SHORT_SCREEN_MQ} and (pointer: coarse) and (min-width: 40rem)`;

const subscribe = mediaQuerySubscription([INSPECTOR_COLUMN_MQ]);
const read = () => matchesMedia(INSPECTOR_COLUMN_MQ);

/** True where the selection Inspector is a column on the inline end. */
export function useInspectorColumn(): boolean {
  return useMediaQueryStore(subscribe, read, () => false);
}
