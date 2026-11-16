import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  EMPTY_FEATURES,
  FeaturesContext,
  type FeaturesState,
  RetryFeaturesContext,
} from "./FeaturesContext";
import {
  fetchFeatures,
  peekCachedFeatures,
  resetFeaturesCache,
} from "./features";

export function FeatureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeaturesState>({
    ready: false,
    manifest: EMPTY_FEATURES,
  });
  const [asked, setAsked] = useState(0);
  // Which ask is current and whether it has answered, so a dropped ask's real
  // answer can end the wait but never replace what the current ask delivered.
  const live = useRef({ mounted: true, current: 0, answered: -1 });
  useEffect(() => {
    const now = live.current;
    now.mounted = true;
    return () => {
      now.mounted = false;
    };
  }, []);
  useEffect(() => {
    const now = live.current;
    now.current = asked;
    void fetchFeatures().then((m) => {
      if (!now.mounted) return;
      if (asked === now.current) {
        now.answered = asked;
        setState({ ready: true, manifest: m });
      } else if (now.answered !== now.current && peekCachedFeatures() === m) {
        // A dropped ask that filled the cache with the host's real answer.
        setState({ ready: true, manifest: m });
      }
    });
  }, [asked]);
  const retry = useCallback(() => {
    resetFeaturesCache();
    setAsked((n) => n + 1);
  }, []);
  return createElement(
    RetryFeaturesContext.Provider,
    { value: retry },
    createElement(FeaturesContext.Provider, { value: state }, children),
  );
}
