import {
  matchesMedia,
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";
import { SHORT_VIEWPORT_MQ } from "./useShortViewport";

const subscribe = mediaQuerySubscription([SHORT_VIEWPORT_MQ]);
const read = () => matchesMedia(SHORT_VIEWPORT_MQ);

/**
 * Whether the layout viewport is short. Unlike `useShortViewport` it ignores
 * the visual viewport, so an on-screen keyboard or a pinch zoom never flips it.
 */
export function useShortLayoutViewport(): boolean {
  return useMediaQueryStore(subscribe, read, () => false);
}
