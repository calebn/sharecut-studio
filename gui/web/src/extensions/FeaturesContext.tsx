import { createContext, useContext } from "react";
import { type FeaturesManifest, hasFeature } from "./features";

export type FeaturesState = {
  ready: boolean;
  manifest: FeaturesManifest;
};

export const EMPTY_FEATURES: FeaturesManifest = {
  api_version: 1,
  features: [],
};

export const FeaturesContext = createContext<FeaturesState>({
  ready: false,
  manifest: EMPTY_FEATURES,
});

export function useFeaturesState(): FeaturesState {
  return useContext(FeaturesContext);
}

export function useFeatures(): FeaturesManifest {
  return useFeaturesState().manifest;
}

export function useFeaturesReady(): boolean {
  return useFeaturesState().ready;
}

export function useHasFeature(id: string): boolean {
  return hasFeature(useFeatures(), id);
}
