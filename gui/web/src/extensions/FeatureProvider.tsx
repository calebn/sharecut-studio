import {
  createElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  EMPTY_FEATURES,
  FeaturesContext,
  type FeaturesState,
  RetryFeaturesContext,
} from "./FeaturesContext";
import { fetchFeatures, resetFeaturesCache } from "./features";

export function FeatureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeaturesState>({
    ready: false,
    manifest: EMPTY_FEATURES,
  });
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchFeatures().then((m) => {
      if (!cancelled) {
        setState({ ready: true, manifest: m });
      }
    });
    return () => {
      cancelled = true;
    };
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
