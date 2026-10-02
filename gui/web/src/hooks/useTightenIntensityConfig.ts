import { useCallback } from "react";
import type { PipelineConfigResponse } from "../types/pipeline";
import { setByPath } from "../utils/configPath";
import { TIGHTEN_INTENSITY_PATH } from "../utils/tightenIntensity";
import { usePipelineWorkingSet } from "./usePipelineWorkingSet";

export interface TightenIntensityConfig {
  cfg: PipelineConfigResponse | null;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  reload: () => void;
  setIntensity: (value: string) => Promise<void>;
  fetchFresh: () => Promise<PipelineConfigResponse | null>;
}

export function useTightenIntensityConfig(
  projectPath: string,
  enabled: boolean,
): TightenIntensityConfig {
  const workingSet = usePipelineWorkingSet(projectPath, enabled);
  const update = workingSet.update;
  const setIntensity = useCallback(
    async (value: string) => {
      try {
        await update((current) => ({
          config: setByPath(current.config, TIGHTEN_INTENSITY_PATH, value),
        }));
      } catch {
        return;
      }
    },
    [update],
  );

  return {
    cfg: workingSet.cfg,
    loadError: workingSet.loadError,
    saveError: workingSet.saveError,
    saving: workingSet.saving,
    reload: workingSet.reload,
    setIntensity,
    fetchFresh: workingSet.fetchFresh,
  };
}
