import { createElement, type ReactNode, useEffect, useState } from "react";
import {
  EMPTY_FEATURES,
  FeaturesContext,
  type FeaturesState,
} from "./FeaturesContext";
import { fetchFeatures } from "./features";

export function FeatureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeaturesState>({
    ready: false,
    manifest: EMPTY_FEATURES,
  });
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
  }, []);
  return createElement(FeaturesContext.Provider, { value: state }, children);
}
