import type { startPipelineRun } from "../api";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import { getByPath, setByPath } from "./configPath";

export const TIGHTEN_INTENSITY_PATH = "tighten.intensity";
export const TIGHTEN_ANALYZE_STEP = "analyze_fillers_pauses";

type RunOptions = NonNullable<Parameters<typeof startPipelineRun>[1]>;

function intensityField(cfg: PipelineConfigResponse | null) {
  return cfg?.params.find((p) => p.path === TIGHTEN_INTENSITY_PATH);
}

/** Choices from the server param catalog (empty until config loads). */
export function tightenIntensityOptions(
  cfg: PipelineConfigResponse | null,
): string[] {
  return [...(intensityField(cfg)?.enum ?? [])];
}

/** Working-set value, else the catalog default, else null. */
export function currentTightenIntensity(
  cfg: PipelineConfigResponse | null,
): string | null {
  if (!cfg) return null;
  const value = getByPath(cfg.config, TIGHTEN_INTENSITY_PATH);
  if (typeof value === "string" && value) return value;
  const fallback = intensityField(cfg)?.default;
  return typeof fallback === "string" ? fallback : null;
}

export function tightenIntensityLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Run only analyze_fillers_pauses with this intensity. `tighten.enabled` is forced
 * on for this run only (use_working_set=false) so a later full pipeline run still
 * skips auto-tighten.
 */
export function tightenProposeRunOptions(
  cfg: PipelineConfigResponse,
  intensity: string,
): RunOptions {
  const withIntensity = setByPath(
    cfg.config,
    TIGHTEN_INTENSITY_PATH,
    intensity,
  );
  return {
    onlyStep: TIGHTEN_ANALYZE_STEP,
    config: setByPath(withIntensity, "tighten.enabled", true),
    unattended: cfg.unattended,
    useWorkingSet: false,
  };
}

/** Confirm text when Find hits would replace listed hits; null for an empty list. */
export function findHitsConfirm(pendingCount: number): string | null {
  if (pendingCount <= 0) return null;
  return `Find hits re-runs tighten analysis and replaces pending hits in this list (${pendingCount} now), including ones you nudged. Continue?`;
}

/** Error of the Find hits job this panel started, once that job fails. */
export function findHitsRunError(
  jobId: string | null,
  job: PipelineJobSnapshot | null,
): string | null {
  if (!jobId || job?.id !== jobId || job.status !== "error") return null;
  return job.error || "Find hits failed.";
}
