import { useMemo } from "react";
import type { ProjectView } from "../types/project";
import {
  type StaleRenderBreakdown,
  staleRenderBreakdown,
} from "../utils/staleRender";

/**
 * The render-state breakdown, memoized per project snapshot. The transport,
 * status bar, timeline and every track header read it; none of them select
 * the playhead, so it only changes with the project, not on each playhead
 * frame.
 */
export function useStaleRenderBreakdown(
  project: ProjectView | null | undefined,
): StaleRenderBreakdown {
  return useMemo(() => staleRenderBreakdown(project), [project]);
}
