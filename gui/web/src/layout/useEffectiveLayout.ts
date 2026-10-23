import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "../hooks/useMediaQueryStore";
import { useDaw } from "../state/useDaw";
import {
  readShortTouchLandscape,
  resolveLayoutMode,
  SHORT_TOUCH_LANDSCAPE_MQ,
} from "./layoutPresentation";

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
