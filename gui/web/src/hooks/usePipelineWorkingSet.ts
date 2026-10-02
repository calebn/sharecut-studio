import { useCallback, useEffect, useRef, useState } from "react";
import { loadPipelineConfig, putPipelineConfig } from "../api";
import type { PipelineConfigResponse } from "../types/pipeline";
import { errorMessage } from "../utils/apiError";
import { useLatestRequest } from "./useLatestRequest";

export type PipelineWorkingSetPatch = Partial<
  Pick<PipelineConfigResponse, "config" | "enabled_steps" | "unattended">
>;

export type PipelineWorkingSetRecipe = (
  current: Readonly<PipelineConfigResponse>,
) => PipelineWorkingSetPatch;

export interface PipelineWorkingSet {
  cfg: PipelineConfigResponse | null;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  reload: () => void;
  update: (recipe: PipelineWorkingSetRecipe) => Promise<boolean>;
  fetchFresh: () => Promise<PipelineConfigResponse | null>;
  reset: () => Promise<boolean>;
}

function applyPatch(
  current: PipelineConfigResponse,
  patch: PipelineWorkingSetPatch,
): PipelineConfigResponse {
  return { ...current, ...patch };
}

export function usePipelineWorkingSet(
  projectPath: string,
  enabled: boolean,
): PipelineWorkingSet {
  const request = useLatestRequest();
  const confirmed = useRef<PipelineConfigResponse | null>(null);
  const confirmedToken = useRef(0);
  const writeEpoch = useRef(0);
  const writeTail = useRef<Promise<void>>(Promise.resolve());
  const [cfg, setCfg] = useState<PipelineConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const recordConfirmedIfNoNewerRead = useCallback(
    (token: number, value: PipelineConfigResponse) => {
      if (confirmedToken.current > token) return;
      confirmed.current = value;
      confirmedToken.current = token;
    },
    [],
  );

  const reload = useCallback(() => {
    writeEpoch.current += 1;
    const token = request.begin();
    confirmedToken.current = token;
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
        confirmedToken.current = token;
        setCfg(next);
      })
      .catch((error: unknown) => {
        if (request.isCurrent(token)) setLoadError(errorMessage(error));
      });
  }, [enabled, projectPath, request]);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback(
    async (recipe: PipelineWorkingSetRecipe): Promise<boolean> => {
      if (!enabled) return false;
      const epoch = writeEpoch.current;
      setSaving(true);
      setSaveError(null);
      const pending = writeTail.current.then(async () => {
        if (epoch !== writeEpoch.current) return false;
        const token = request.begin();
        const base = confirmed.current;
        if (!base) {
          if (request.isCurrent(token)) setSaving(false);
          return false;
        }
        try {
          setCfg(applyPatch(base, recipe(base)));
          const fresh = await loadPipelineConfig(projectPath);
          if (!request.isCurrent(token)) return false;
          confirmed.current = fresh;
          confirmedToken.current = token;
          setCfg(applyPatch(fresh, recipe(fresh)));
          const saved = await putPipelineConfig(projectPath, recipe(fresh));
          recordConfirmedIfNoNewerRead(token, saved);
          if (!request.isCurrent(token)) return false;
          setCfg(saved);
          return true;
        } catch (error) {
          if (!request.isCurrent(token)) return false;
          setCfg(confirmed.current);
          setSaveError(errorMessage(error));
          throw error;
        } finally {
          if (request.isCurrent(token)) setSaving(false);
        }
      });
      writeTail.current = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    [enabled, projectPath, request, recordConfirmedIfNoNewerRead],
  );

  const fetchFresh = useCallback(async () => {
    if (!enabled) return null;
    writeEpoch.current += 1;
    const token = request.begin();
    setSaving(false);
    setSaveError(null);
    const fresh = await loadPipelineConfig(projectPath);
    if (!request.isCurrent(token)) return null;
    confirmed.current = fresh;
    confirmedToken.current = token;
    setCfg(fresh);
    return fresh;
  }, [enabled, projectPath, request]);

  const reset = useCallback(async () => {
    if (!enabled) return false;
    writeEpoch.current += 1;
    const token = request.begin();
    setSaving(true);
    setSaveError(null);
    const pending = writeTail.current.then(async () => {
      if (!request.isCurrent(token)) return false;
      try {
        const saved = await putPipelineConfig(projectPath, { reset: true });
        recordConfirmedIfNoNewerRead(token, saved);
        if (!request.isCurrent(token)) return false;
        setCfg(saved);
        return true;
      } catch (error) {
        if (!request.isCurrent(token)) return false;
        setCfg(confirmed.current);
        setSaveError(errorMessage(error));
        throw error;
      } finally {
        if (request.isCurrent(token)) setSaving(false);
      }
    });
    writeTail.current = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }, [enabled, projectPath, request, recordConfirmedIfNoNewerRead]);

  return {
    cfg,
    loadError,
    saveError,
    saving,
    reload,
    update,
    fetchFresh,
    reset,
  };
}
