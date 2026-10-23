import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import {
  readShortTouchLandscape,
  resolveLayoutMode,
  SHORT_TOUCH_LANDSCAPE_MQ,
} from "../state/layoutPresentation";
import { useDaw } from "../state/useDaw";

const subscribe = mediaQuerySubscription([SHORT_TOUCH_LANDSCAPE_MQ]);
const serverSnapshot = () => false;

export function useEffectiveLayout() {
  const { layoutMode, shellBreakpoint } = useDaw((s) => ({
    layoutMode: s.layoutMode,
    shellBreakpoint: s.shellBreakpoint,
  }));
  const shortTouchLandscape = useMediaQueryStore(
    subscribe,
    readShortTouchLandscape,
    serverSnapshot,
  );
  return resolveLayoutMode(layoutMode, shellBreakpoint, shortTouchLandscape);
}
