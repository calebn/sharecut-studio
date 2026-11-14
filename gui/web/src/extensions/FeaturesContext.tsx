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

/** Drops the features call in flight and asks again; for a call that never answers. */
export const RetryFeaturesContext = createContext<() => void>(() => {});

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

export function useRetryFeatures(): () => void {
  return useContext(RetryFeaturesContext);
}
