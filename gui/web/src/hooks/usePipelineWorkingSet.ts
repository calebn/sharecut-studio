import { useCallback, useEffect, useRef, useState } from "react";
import { loadPipelineConfig, putPipelineConfig } from "../api";
import type { PipelineConfigResponse } from "../types/pipeline";
import { errorMessage } from "../utils/apiError";
import { useLatestRequest } from "./useLatestRequest";

export type PipelineWorkingSetPatch = Partial<
  Pick<PipelineConfigResponse, "config" | "enabled_steps" | "unattended">
>;

type PipelineWorkingSetRecipe = (
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
}

interface WorkingSetOwner {
  projectPath: string;
  enabled: boolean;
}

interface WorkingSetRead {
  owner: WorkingSetOwner;
  requestToken: number;
  cfg: PipelineConfigResponse | null;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
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
  const [read, setRead] = useState<WorkingSetRead>(() => ({
    owner: { projectPath, enabled },
    requestToken: 0,
    cfg: null,
    loadError: null,
    saveError: null,
    saving: false,
  }));
  const { owner } = read;
  const activeOwner = useRef<WorkingSetOwner | null>(null);
  if (owner.projectPath !== projectPath || owner.enabled !== enabled) {
    setRead({
      owner: { projectPath, enabled },
      requestToken: 0,
      cfg: null,
      loadError: null,
      saveError: null,
      saving: false,
    });
  }
  const recordConfirmedIfNoNewerRead = useCallback(
    (token: number, value: PipelineConfigResponse) => {
      if (confirmedToken.current > token) return;
      confirmed.current = value;
      confirmedToken.current = token;
    },
    [],
  );

  const reload = useCallback(() => {
    if (activeOwner.current !== owner) return;
    writeEpoch.current += 1;
    const token = request.begin();
    confirmedToken.current = token;
    confirmed.current = null;
    setRead((current) =>
      current.owner === owner
        ? {
            ...current,
            requestToken: token,
            cfg: null,
            loadError: null,
            saveError: null,
            saving: false,
          }
        : current,
    );
    if (owner.enabled) {
      void loadPipelineConfig(owner.projectPath)
        .then((next) => {
          if (!request.isCurrent(token)) return;
          confirmed.current = next;
          confirmedToken.current = token;
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? { ...current, requestToken: token, cfg: next }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!request.isCurrent(token)) return;
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? {
                  ...current,
                  requestToken: token,
                  loadError: errorMessage(error),
                }
              : current,
          );
        });
    }
  }, [owner, request]);

  useEffect(() => {
    activeOwner.current = owner;
    writeEpoch.current += 1;
    const token = request.begin();
    confirmedToken.current = token;
    confirmed.current = null;
    if (owner.enabled) {
      void loadPipelineConfig(owner.projectPath)
        .then((next) => {
          if (!request.isCurrent(token)) return;
          confirmed.current = next;
          confirmedToken.current = token;
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? { ...current, requestToken: token, cfg: next }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!request.isCurrent(token)) return;
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? {
                  ...current,
                  requestToken: token,
                  loadError: errorMessage(error),
                }
              : current,
          );
        });
    }
    return () => {
      request.invalidate();
      activeOwner.current = null;
      writeEpoch.current += 1;
    };
  }, [owner, request]);

  const update = useCallback(
    async (recipe: PipelineWorkingSetRecipe): Promise<boolean> => {
      if (!owner.enabled || activeOwner.current !== owner) return false;
      const epoch = writeEpoch.current;
      setRead((current) =>
        current.owner === owner
          ? { ...current, saving: true, saveError: null }
          : current,
      );
      const pending = writeTail.current.then(async () => {
        if (epoch !== writeEpoch.current) return false;
        const token = request.begin();
        const base = confirmed.current;
        if (!base) {
          if (request.isCurrent(token)) {
            setRead((current) =>
              current.owner === owner ? { ...current, saving: false } : current,
            );
          }
          return false;
        }
        try {
          const optimistic = applyPatch(base, recipe(base));
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? { ...current, requestToken: token, cfg: optimistic }
              : current,
          );
          const fresh = await loadPipelineConfig(owner.projectPath);
          if (!request.isCurrent(token)) return false;
          confirmed.current = fresh;
          confirmedToken.current = token;
          const refreshed = applyPatch(fresh, recipe(fresh));
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? { ...current, requestToken: token, cfg: refreshed }
              : current,
          );
          const saved = await putPipelineConfig(
            owner.projectPath,
            recipe(fresh),
          );
          recordConfirmedIfNoNewerRead(token, saved);
          if (!request.isCurrent(token)) return false;
          setRead((current) =>
            current.owner === owner && current.requestToken <= token
              ? { ...current, requestToken: token, cfg: saved }
              : current,
          );
          return true;
        } catch (error) {
          if (!request.isCurrent(token)) return false;
          const cfg = confirmed.current;
          setRead((current) =>
            current.owner === owner
              ? {
                  ...current,
                  requestToken: token,
                  cfg,
                  saveError: errorMessage(error),
                }
              : current,
          );
          throw error;
        } finally {
          if (request.isCurrent(token)) {
            setRead((current) =>
              current.owner === owner ? { ...current, saving: false } : current,
            );
          }
        }
      });
      writeTail.current = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
    [owner, request, recordConfirmedIfNoNewerRead],
  );

  const fetchFresh = useCallback(async () => {
    if (!owner.enabled || activeOwner.current !== owner) return null;
    writeEpoch.current += 1;
    const token = request.begin();
    setRead((current) =>
      current.owner === owner
        ? { ...current, requestToken: token, saving: false, saveError: null }
        : current,
    );
    const fresh = await loadPipelineConfig(owner.projectPath);
    if (!request.isCurrent(token)) return null;
    confirmed.current = fresh;
    confirmedToken.current = token;
    setRead((current) =>
      current.owner === owner && current.requestToken <= token
        ? { ...current, requestToken: token, cfg: fresh }
        : current,
    );
    return fresh;
  }, [owner, request]);

  return {
    cfg: read.cfg,
    loadError: read.loadError,
    saveError: read.saveError,
    saving: read.saving,
    reload,
    update,
    fetchFresh,
  };
}
