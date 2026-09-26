import { useCallback, useEffect, useRef, useState } from "react";
import { loadPipelineConfig, putPipelineConfig } from "../api";
import type { PipelineConfigResponse } from "../types/pipeline";
import { errorMessage } from "../utils/apiError";
import { setByPath } from "../utils/configPath";
import { TIGHTEN_INTENSITY_PATH } from "../utils/tightenIntensity";
import { useLatestRequest } from "./useLatestRequest";

export interface TightenIntensityConfig {
  /** Last server-confirmed config (optimistic intensity while a save runs). */
  cfg: PipelineConfigResponse | null;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  reload: () => void;
  setIntensity: (value: string) => Promise<void>;
  /** Working set refetched right before a run (clears saving and saveError); null when superseded. */
  fetchFresh: () => Promise<PipelineConfigResponse | null>;
}

/**
 * Tighten tab view of the shared pipeline working set. One latest-wins token
 * guards load, save and pre-run refetch, so a late response for an older
 * request or another project never overwrites newer state. A save refetches
 * before the PUT so only `tighten.intensity` changes.
 */
export function useTightenIntensityConfig(
  projectPath: string,
  enabled: boolean,
): TightenIntensityConfig {
  const request = useLatestRequest();
  const confirmed = useRef<PipelineConfigResponse | null>(null);
  const [cfg, setCfg] = useState<PipelineConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    const token = request.begin();
    confirmed.current = null;
    setCfg(null);
    setLoadError(null);
    setSaveError(null);
    setSaving(false);
    if (!enabled) return;
    void loadPipelineConfig(projectPath)
      .then((next) => {
        if (!request.isCurrent(token)) return;
        confirmed.current = next;
        setCfg(next);
      })
      .catch((e: unknown) => {
        if (request.isCurrent(token)) setLoadError(errorMessage(e));
      });
  }, [enabled, projectPath, request]);

  useEffect(() => {
    reload();
  }, [reload]);

  const setIntensity = useCallback(
    async (value: string) => {
      const base = confirmed.current;
      if (!enabled || !base) return;
      const token = request.begin();
      setSaving(true);
      setSaveError(null);
      setCfg({
        ...base,
        config: setByPath(base.config, TIGHTEN_INTENSITY_PATH, value),
      });
      try {
        // Refetch so the PUT changes only tighten.intensity, not other
        // working-set edits made since this panel loaded.
        const fresh = await loadPipelineConfig(projectPath);
        if (!request.isCurrent(token)) return;
        const saved = await putPipelineConfig(projectPath, {
          config: setByPath(fresh.config, TIGHTEN_INTENSITY_PATH, value),
        });
        if (!request.isCurrent(token)) return;
        confirmed.current = saved;
        setCfg(saved);
      } catch (e) {
        if (!request.isCurrent(token)) return;
        setCfg(confirmed.current);
        setSaveError(errorMessage(e));
      } finally {
        if (request.isCurrent(token)) setSaving(false);
      }
    },
    [enabled, projectPath, request],
  );

  const fetchFresh = useCallback(async () => {
    if (!enabled) return null;
    const token = request.begin();
    // A pre-run refetch supersedes any in-flight save (its finally no longer
    // runs setSaving(false)) and starts a new action, so clear both the busy
    // flag and a stale save error: the run's own result is what shows next.
    setSaving(false);
    setSaveError(null);
    const fresh = await loadPipelineConfig(projectPath);
    return request.isCurrent(token) ? fresh : null;
  }, [enabled, projectPath, request]);

  return {
    cfg,
    loadError,
    saveError,
    saving,
    reload,
    setIntensity,
    fetchFresh,
  };
}
