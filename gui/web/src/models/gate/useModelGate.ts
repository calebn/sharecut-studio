import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDawStore } from "../../state/dawStore";
import { isModelNeeded, type ModelNeeded } from "../../utils/apiError";
import { modelActivity } from "../activity";
import type { ModelState, ModelView } from "../types";
import { INERT_MODELS, type ModelsApi, ModelsContext } from "../useModels";

export type ModelNeed = {
  id: string;
  variant?: string;
  /** What the caller knows about this exact model; overrides the row, which holds one Whisper size. */
  installed?: boolean;
};

export type GateResult<T> =
  | { kind: "ran"; value: T }
  | { kind: "declined"; id: string; label: string };

export type GatePhase = "ask" | "downloading" | "failed" | "ready";

export type GatePrompt = {
  need: ModelNeed;
  label: string;
  purpose: string;
  size: string;
  phase: GatePhase;
  /** The row to show: never "installed" before the person has a reason to continue. */
  view: ModelView;
  blockedReason: string | undefined;
};

export type ModelGate = {
  run<T>(
    action: (ctx: { afterDownload: boolean }) => Promise<T>,
    needs?: ModelNeed[],
  ): Promise<GateResult<T>>;
  prompt: GatePrompt | null;
  /** Set after "Not now"; cleared on the next run() or once that model is installed. */
  declined: { id: string; label: string } | null;
  accept: () => void;
  decline: () => void;
  cancelDownload: () => void;
  openModels: () => void;
};

type NeedInfo = { label: string; purpose: string; size: string };

type Session = {
  token: object;
  need: ModelNeed;
  info: NeedInfo;
  tried: boolean;
  failed: boolean;
  downloading: boolean;
  sawMissing: boolean;
};

type Waiter = { token: object; resolve: (accepted: boolean) => void };

const MAX_PROMPTS = 3;

function rowFor(api: ModelsApi, need: ModelNeed): ModelView | null {
  return api.models?.find((m) => m.id === need.id) ?? null;
}

function rowInstalled(row: ModelView | null, need: ModelNeed): boolean {
  return (
    row?.state.kind === "installed" &&
    (need.id !== "whisper" || !need.variant || row.variant === need.variant)
  );
}

function otherVariant(row: ModelView | null, need: ModelNeed): boolean {
  return (
    row !== null &&
    need.id === "whisper" &&
    !!need.variant &&
    row.variant !== need.variant
  );
}

function infoFor(api: ModelsApi, need: ModelNeed): NeedInfo {
  const row = rowFor(api, need);
  const variant =
    need.id === "whisper" && need.variant
      ? api.whisper.variants.find((v) => v.id === need.variant)
      : undefined;
  return {
    label: row?.label ?? need.id,
    purpose: row?.purpose ?? "",
    size: variant?.size ?? row?.size ?? "",
  };
}

function infoOfModel(model: ModelNeeded): NeedInfo {
  return { label: model.label, purpose: model.purpose, size: model.size };
}

function shownState(
  live: ModelView | null,
  session: Session,
  matched: boolean,
): ModelState {
  if (!live) {
    return { kind: "missing" };
  }
  if (matched) {
    return session.sawMissing ? { kind: "installed" } : { kind: "missing" };
  }
  return live.state.kind === "failed" && !session.tried
    ? { kind: "missing" }
    : live.state;
}

export function useModelGate(): ModelGate {
  const context = useContext(ModelsContext);
  const api = context ?? INERT_MODELS;
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const inert = context === null;

  const [session, setSession] = useState<Session | null>(null);
  const [declined, setDeclined] = useState<ModelGate["declined"]>(null);
  const [manageRequested, setManageRequested] = useState(false);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const waiter = useRef<Waiter | null>(null);

  const patch = useCallback((token: object, change: Partial<Session>) => {
    setSession((s) => (s && s.token === token ? { ...s, ...change } : s));
  }, []);

  const settle = useCallback((accepted: boolean) => {
    const w = waiter.current;
    waiter.current = null;
    setSession(null);
    w?.resolve(accepted);
  }, []);

  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      waiter.current?.resolve(false);
      waiter.current = null;
    };
  }, []);

  const ask = useCallback(
    (need: ModelNeed, info: NeedInfo): Promise<boolean> => {
      waiter.current?.resolve(false);
      if (unmounted.current) {
        return Promise.resolve(false);
      }
      const token = {};
      const live = rowFor(apiRef.current, need);
      return new Promise<boolean>((resolve) => {
        waiter.current = { token, resolve };
        setSession({
          token,
          need,
          info,
          tried: false,
          failed: false,
          downloading: false,
          sawMissing: !rowInstalled(live, need),
        });
      });
    },
    [],
  );

  const run = useCallback(
    async <T>(
      action: (ctx: { afterDownload: boolean }) => Promise<T>,
      needs: ModelNeed[] = [],
    ): Promise<GateResult<T>> => {
      if (inert) {
        return { kind: "ran", value: await action({ afterDownload: false }) };
      }
      setDeclined(null);
      const accepted = new Set<string>();
      let prompts = 0;
      let afterDownload = false;
      const decide = async (
        need: ModelNeed,
        info: NeedInfo,
      ): Promise<GateResult<never> | null> => {
        prompts += 1;
        if (!(await ask(need, info))) {
          setDeclined({ id: need.id, label: info.label });
          return { kind: "declined", id: need.id, label: info.label };
        }
        accepted.add(need.id);
        afterDownload = true;
        return null;
      };
      for (const need of needs) {
        const row = rowFor(apiRef.current, need);
        if (row === null || (need.installed ?? rowInstalled(row, need))) {
          continue;
        }
        const refusal = await decide(need, infoFor(apiRef.current, need));
        if (refusal) {
          return refusal;
        }
      }
      for (;;) {
        try {
          return { kind: "ran", value: await action({ afterDownload }) };
        } catch (e: unknown) {
          if (
            !isModelNeeded(e) ||
            accepted.has(e.model.id) ||
            prompts >= MAX_PROMPTS
          ) {
            throw e;
          }
          await apiRef.current.refresh();
          const refusal = await decide(
            {
              id: e.model.id,
              variant: e.model.variant ?? undefined,
              installed: false,
            },
            infoOfModel(e.model),
          );
          if (refusal) {
            return refusal;
          }
        }
      }
    },
    [ask, inert],
  );

  const matched = session
    ? rowInstalled(rowFor(api, session.need), session.need)
    : false;
  const sawMissing = session?.sawMissing ?? true;
  const token = session?.token;
  useEffect(() => {
    if (token && !matched && !sawMissing) {
      patch(token, { sawMissing: true });
    }
  }, [token, matched, sawMissing, patch]);

  const declinedId = declined?.id;
  const declinedInstalled =
    declinedId !== undefined &&
    api.models?.find((m) => m.id === declinedId)?.state.kind === "installed";
  useEffect(() => {
    if (declinedInstalled) {
      setDeclined(null);
    }
  }, [declinedInstalled]);

  const prompt = useMemo<GatePrompt | null>(() => {
    if (!session) {
      return null;
    }
    const { need, info } = session;
    const row = api.models?.find((m) => m.id === need.id) ?? null;
    const foreign = !session.downloading && otherVariant(row, need);
    const live = foreign ? null : row;
    const activity = modelActivity(live, api.busy);
    const isMatched = rowInstalled(live, need);
    let phase: GatePhase = "ask";
    if (session.downloading || activity.working) {
      phase = "downloading";
    } else if (session.failed) {
      phase = "failed";
    } else if (isMatched && session.sawMissing) {
      phase = "ready";
    }
    const base: ModelView = live ?? {
      id: need.id,
      label: info.label,
      purpose: info.purpose,
      tier: "offered",
      size: info.size,
      sizeBytes: null,
      variant: need.variant ?? null,
      state: { kind: "missing" },
    };
    return {
      need,
      label: info.label,
      purpose: info.purpose,
      size: info.size,
      phase,
      view: {
        ...base,
        label: info.label,
        size: info.size,
        variant: need.variant ?? base.variant,
        state: shownState(live, session, isMatched),
      },
      blockedReason: activity.blockedReason,
    };
  }, [session, api.models, api.busy]);

  const accept = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.downloading) {
      return;
    }
    if (s.sawMissing && rowInstalled(rowFor(apiRef.current, s.need), s.need)) {
      settle(true);
      return;
    }
    const { need, token: sessionToken } = s;
    patch(sessionToken, { downloading: true, tried: true, failed: false });
    const options =
      need.id === "whisper" && need.variant
        ? { whisperModel: need.variant }
        : undefined;
    void apiRef.current.download([need.id], options).then((outcome) => {
      if (waiter.current?.token !== sessionToken) {
        return;
      }
      if (outcome.kind === "ok") {
        settle(true);
      } else {
        patch(sessionToken, {
          downloading: false,
          failed: outcome.kind === "failed",
        });
      }
    });
  }, [patch, settle]);

  const decline = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.downloading) {
      return;
    }
    setDeclined({ id: s.need.id, label: s.info.label });
    settle(false);
  }, [settle]);

  const cancelDownload = useCallback(() => {
    void apiRef.current.cancel();
  }, []);

  const openModels = useCallback(() => {
    const s = sessionRef.current;
    if (s?.downloading) {
      return;
    }
    if (s) {
      setDeclined({ id: s.need.id, label: s.info.label });
      settle(false);
    }
    setManageRequested(true);
  }, [settle]);

  useEffect(() => {
    if (manageRequested && session === null) {
      setManageRequested(false);
      useDawStore.getState().setModelsDialogOpen(true);
    }
  }, [manageRequested, session]);

  return useMemo(
    () => ({
      run,
      prompt,
      declined,
      accept,
      decline,
      cancelDownload,
      openModels,
    }),
    [run, prompt, declined, accept, decline, cancelDownload, openModels],
  );
}
