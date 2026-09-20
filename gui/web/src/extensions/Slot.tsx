import type { ReactNode } from "react";
import { useFeaturesState } from "./FeaturesContext";
import { hasFeature } from "./features";

/**
 * Render children only when a feature id is present (absent = no render).
 * While the manifest is loading, renders fallback (default null).
 */
export function Slot({
  id,
  children,
  fallback = null,
}: {
  id: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { ready, manifest } = useFeaturesState();
  if (!ready) {
    return fallback;
  }
  if (!hasFeature(manifest, id)) {
    return null;
  }
  return children;
}
