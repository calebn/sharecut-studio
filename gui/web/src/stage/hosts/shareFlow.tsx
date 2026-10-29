import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createHostRecordRoom,
  createHostShare,
  listHostShares,
  replaceHostRecordInvite,
  revokeHostRoom,
  revokeHostShare,
} from "../../api";
import { execute } from "../../commands/execute";
import type { ExecuteResult } from "../../commands/types";
import { copyText } from "../../record";
import {
  corsWarning,
  createRecoveryOf,
  SHARE_DEFAULTS,
  type ShareChoices,
  type ShareCopiedKey,
  type ShareCopyKind,
  type ShareCreateRecovery,
  shareCopyKey,
} from "../../stages/deliver/shareLogic";
import { useDawStore } from "../../state/dawStore";
import { type HostShareRow, REVIEW_ROLES } from "../../types/shares";
import { errorMessage } from "../../utils/apiError";
import { copyWhenReady } from "./copyWhenReady";
import { Flow, type ShareFlow } from "./shareFlowContext";

const COPIED_MS = 2000;

/** The project and visit a result belongs to; anything else is dropped. */
type Scope = {
  projectPath: string;
  projectEpoch: number;
  generation: number;
};

type CreateRequest = { scope: Scope; choices: ShareChoices };
type Owner = { scope: Scope };

const NO_ADDRESS = new Error("The link has no address to copy yet.");
const ABANDONED = new Error(
  "The project or stage changed before the link arrived.",
);

/**
 * The host's review links and record rooms, outside any stage so a result
 * that arrives after a click is still tied to the project and visit that made
 * it. Opening another project or leaving Deliver starts over: the choices, a pending Refresh mix retry and any result still on
 * its way are dropped. The listed links stay across a visit and are listed
 * again as Deliver shows.
 */
export function ShareFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const onDeliver = useDawStore((s) => s.stage === "deliver");
  const announceStatus = useDawStore((s) => s.announceStatus);
  const [rows, setRows] = useState<readonly HostShareRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [choices, setChoices] = useState<ShareChoices>(SHARE_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(null);
  const [blockedKey, setBlockedKey] = useState<ShareCopiedKey | null>(null);
  const [recovery, setRecovery] = useState<ShareCreateRecovery>({
    kind: "idle",
  });
  const mounted = useRef(true);
  const generation = useRef(0);
  const loadGeneration = useRef(0);
  const busyOwner = useRef<Owner | null>(null);
  const staleRequest = useRef<CreateRequest | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const seen = useRef({ projectPath, projectEpoch, onDeliver });

  const clearCopiedTimer = useCallback(() => {
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
  }, []);

  const markCopied = useCallback(
    (key: ShareCopiedKey) => {
      clearCopiedTimer();
      setBlockedKey(null);
      setCopiedKey(key);
      copiedTimer.current = setTimeout(() => setCopiedKey(null), COPIED_MS);
    },
    [clearCopiedTimer],
  );

  const announce = useCallback(
    (message: string) => {
      setStatus(message);
      announceStatus(message);
    },
    [announceStatus],
  );

  const scopeNow = useCallback((): Scope => {
    const s = useDawStore.getState();
    return {
      projectPath: s.projectPath ?? "",
      projectEpoch: s.projectEpoch,
      generation: generation.current,
    };
  }, []);

  const isCurrent = useCallback((scope: Scope): boolean => {
    const s = useDawStore.getState();
    return (
      scope.generation === generation.current &&
      scope.projectPath === s.projectPath &&
      scope.projectEpoch === s.projectEpoch &&
      s.project !== null &&
      s.stage === "deliver"
    );
  }, []);

  const begin = useCallback(
    (scope: Scope): Owner | null => {
      if (!isCurrent(scope) || busyOwner.current !== null) return null;
      const owner: Owner = { scope };
      busyOwner.current = owner;
      setBusy(true);
      setError(null);
      setStatus(null);
      setBlockedKey(null);
      return owner;
    },
    [isCurrent],
  );

  const finish = useCallback(
    (owner: Owner) => {
      if (busyOwner.current !== owner) return;
      busyOwner.current = null;
      if (isCurrent(owner.scope)) setBusy(false);
    },
    [isCurrent],
  );

  const load = useCallback(
    async (scope: Scope) => {
      if (!isCurrent(scope)) return;
      const mine = ++loadGeneration.current;
      try {
        const data = await listHostShares(scope.projectPath);
        if (mine !== loadGeneration.current || !isCurrent(scope)) return;
        setRows(data.shares);
        setLoaded(true);
      } catch (err) {
        if (mine === loadGeneration.current && isCurrent(scope)) {
          setError(errorMessage(err));
        }
      }
    },
    [isCurrent],
  );

  /** Lists again after a result the visit that made it no longer shows, when the same project is back on Deliver. */
  const relist = useCallback(
    (scope: Scope) => {
      const s = useDawStore.getState();
      if (
        mounted.current &&
        scope.projectPath === s.projectPath &&
        scope.projectEpoch === s.projectEpoch &&
        s.project !== null &&
        s.stage === "deliver"
      ) {
        void load(scopeNow());
      }
    },
    [load, scopeNow],
  );

  // A new project or leaving Deliver ends the visit: what was in flight is
  // dropped. Only a new project forgets the listed links.
  useLayoutEffect(() => {
    const before = seen.current;
    if (
      before.projectPath === projectPath &&
      before.projectEpoch === projectEpoch &&
      before.onDeliver === onDeliver
    ) {
      return;
    }
    const sameProject =
      before.projectPath === projectPath &&
      before.projectEpoch === projectEpoch;
    seen.current = { projectPath, projectEpoch, onDeliver };
    generation.current += 1;
    loadGeneration.current += 1;
    busyOwner.current = null;
    staleRequest.current = null;
    clearCopiedTimer();
    setBusy(false);
    setError(null);
    setStatus(null);
    setCopiedKey(null);
    setBlockedKey(null);
    setRecovery({ kind: "idle" });
    setChoices(SHARE_DEFAULTS);
    if (!sameProject) {
      setRows([]);
      setLoaded(false);
    }
  }, [projectPath, projectEpoch, onDeliver, clearCopiedTimer]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearCopiedTimer();
      generation.current += 1;
      loadGeneration.current += 1;
      busyOwner.current = null;
    };
  }, [clearCopiedTimer]);

  const reload = useCallback(() => void load(scopeNow()), [load, scopeNow]);

  // The Share dialog makes and stops links too; list again when it closes.
  const dialogOpen = useDawStore((s) => s.chrome.shareDialogOpen);
  const dialogWasOpen = useRef(dialogOpen);
  useEffect(() => {
    const wasOpen = dialogWasOpen.current;
    dialogWasOpen.current = dialogOpen;
    if (wasOpen && !dialogOpen && onDeliver) reload();
  }, [dialogOpen, onDeliver, reload]);

  /**
   * Mints and copies. `minted` is already running and the copy starts with it,
   * then takes the link when it arrives; from a click, that keeps the gesture.
   */
  const finishCreate = useCallback(
    async (request: CreateRequest, minted: Promise<HostShareRow>) => {
      const copying = copyWhenReady(
        minted.then((share) => {
          if (!isCurrent(request.scope)) throw ABANDONED;
          if (!share.url) throw NO_ADDRESS;
          return share.url;
        }),
      );
      copying.catch(() => undefined);
      let share: HostShareRow;
      try {
        share = await minted;
      } catch (err) {
        if (!isCurrent(request.scope)) return;
        const recoverable = createRecoveryOf(err);
        staleRequest.current = null;
        if (recoverable.kind === "refresh") {
          staleRequest.current = request;
          setRecovery({
            kind: "needs_refresh",
            message: recoverable.message,
            refreshError: null,
          });
        } else if (recoverable.kind === "stale_master") {
          setRecovery({ kind: "idle" });
          setError(recoverable.message);
        } else {
          setRecovery({ kind: "idle" });
          setError(errorMessage(err));
        }
        return;
      }
      if (!isCurrent(request.scope)) {
        relist(request.scope);
        return;
      }
      staleRequest.current = null;
      setRecovery({ kind: "idle" });
      if (share.url) {
        try {
          await copying;
          if (!isCurrent(request.scope)) return;
          markCopied(shareCopyKey("link", share.token));
          announce("Review link created and copied");
        } catch {
          if (!isCurrent(request.scope)) return;
          setBlockedKey(shareCopyKey("link", share.token));
          announce(
            "Review link created. Your browser would not copy it, so it is selected: copy it with the keyboard.",
          );
        }
      } else {
        announce("Review link created");
      }
      await load(request.scope);
      const cors = corsWarning(share);
      if (cors && isCurrent(request.scope)) setError(cors);
    },
    [announce, isCurrent, load, markCopied, relist],
  );

  const startCreate = useCallback(
    (request: CreateRequest) =>
      finishCreate(
        request,
        createHostShare(request.scope.projectPath, {
          role: request.choices.role,
          with_mcp: request.choices.withMcp,
          ...(request.choices.freeze ? { freeze: true } : {}),
        }),
      ),
    [finishCreate],
  );

  const create = useCallback(() => {
    const request: CreateRequest = {
      scope: scopeNow(),
      choices: choicesRef.current,
    };
    const owner = begin(request.scope);
    if (!owner) return;
    staleRequest.current = null;
    setRecovery({ kind: "idle" });
    // The mint starts here, in the click, so the copy keeps its gesture.
    void startCreate(request)
      .catch((err) => {
        if (isCurrent(request.scope)) setError(errorMessage(err));
      })
      .finally(() => finish(owner));
  }, [begin, finish, isCurrent, scopeNow, startCreate]);

  const refreshMix = useCallback(() => {
    const current = recoveryRef.current;
    if (current.kind !== "needs_refresh") return;
    const { message } = current;
    const stale = staleRequest.current;
    if (!stale || !isCurrent(stale.scope)) return;
    const retry: CreateRequest = {
      scope: stale.scope,
      choices: choicesRef.current,
    };
    const owner = begin(retry.scope);
    if (!owner) return;
    setRecovery({ kind: "refreshing" });
    void (async () => {
      try {
        let result: ExecuteResult;
        try {
          result = await execute("render.refreshMix");
        } catch (err) {
          if (isCurrent(retry.scope)) {
            setRecovery({
              kind: "needs_refresh",
              message,
              refreshError: errorMessage(err),
            });
          }
          return;
        }
        if (!isCurrent(retry.scope)) return;
        if (result.status !== "ok") {
          setRecovery({
            kind: "needs_refresh",
            message,
            refreshError:
              result.status === "disabled"
                ? result.reason
                : "Refresh mix is unavailable",
          });
          return;
        }
        setRecovery({ kind: "retrying" });
        await startCreate(retry);
      } finally {
        finish(owner);
      }
    })();
  }, [begin, finish, isCurrent, startCreate]);

  const act = useCallback(
    (run: (scope: Scope) => Promise<void>) => {
      const scope = scopeNow();
      const owner = begin(scope);
      if (!owner) return;
      void (async () => {
        try {
          await run(scope);
        } catch (err) {
          if (isCurrent(scope)) setError(errorMessage(err));
        } finally {
          finish(owner);
        }
      })();
    },
    [begin, finish, isCurrent, scopeNow],
  );

  const createRecord = useCallback(() => {
    const scope = scopeNow();
    const owner = begin(scope);
    if (!owner) return;
    const made = createHostRecordRoom(scope.projectPath);
    const copying = copyWhenReady(
      made.then((room) => {
        if (!isCurrent(scope)) throw ABANDONED;
        if (!room.guest.url) throw NO_ADDRESS;
        return room.guest.url;
      }),
    );
    copying.catch(() => undefined);
    void (async () => {
      try {
        const room = await made;
        if (!isCurrent(scope)) {
          relist(scope);
          return;
        }
        if (room.guest.url) {
          try {
            await copying;
            if (!isCurrent(scope)) return;
            markCopied(shareCopyKey("link", room.guest.token));
            announce("Record links created and guest link copied");
          } catch {
            if (!isCurrent(scope)) return;
            announce("Record links created");
            setError(
              `Your browser would not copy the guest link. Use Copy guest link, or copy it by hand: ${room.guest.url}`,
            );
          }
        } else {
          announce("Record links created");
        }
        await load(scope);
      } catch (err) {
        if (isCurrent(scope)) setError(errorMessage(err));
      } finally {
        finish(owner);
      }
    })();
  }, [announce, begin, finish, isCurrent, load, markCopied, relist, scopeNow]);

  const replaceInvite = useCallback(
    (sourceToken: string) => {
      const scope = scopeNow();
      const owner = begin(scope);
      if (!owner) return;
      const made = replaceHostRecordInvite(scope.projectPath, sourceToken);
      const copying = copyWhenReady(
        made.then((share) => {
          if (!isCurrent(scope)) throw ABANDONED;
          if (!share.url) throw NO_ADDRESS;
          return share.url;
        }),
      );
      copying.catch(() => undefined);
      void (async () => {
        try {
          const share = await made;
          if (!isCurrent(scope)) {
            relist(scope);
            return;
          }
          const who = share.record_role === "producer" ? "Producer" : "Guest";
          if (share.url) {
            try {
              await copying;
              if (!isCurrent(scope)) return;
              markCopied(shareCopyKey("link", share.token));
              announce(`${who} link replaced and copied`);
            } catch {
              if (!isCurrent(scope)) return;
              announce("Record invite replaced");
              setError(
                `Your browser would not copy the ${who.toLowerCase()} link. Copy it by hand: ${share.url}`,
              );
            }
          } else {
            announce("Record invite replaced");
          }
          await load(scope);
        } catch (err) {
          if (isCurrent(scope)) setError(errorMessage(err));
        } finally {
          finish(owner);
        }
      })();
    },
    [announce, begin, finish, isCurrent, load, markCopied, relist, scopeNow],
  );

  const copy = useCallback(
    (
      kind: ShareCopyKind,
      token: string,
      label: string,
      text: string | null,
    ) => {
      const scope = scopeNow();
      if (!text || !isCurrent(scope)) return;
      setError(null);
      setBlockedKey(null);
      void (async () => {
        try {
          await copyText(text);
          if (!isCurrent(scope)) return;
          markCopied(shareCopyKey(kind, token));
          announce(`${label} copied`);
        } catch {
          if (!isCurrent(scope)) return;
          const key = shareCopyKey(kind, token);
          const onRow = rowsRef.current.some(
            (row) => row.token === token && row.kind !== "record",
          );
          if (kind === "link" && onRow) {
            // The row selects the whole link for the keyboard.
            setBlockedKey(key);
          } else {
            setError(
              `Your browser would not copy the ${label.toLowerCase()}. Copy it by hand: ${text}`,
            );
          }
        }
      })();
    },
    [announce, isCurrent, markCopied, scopeNow],
  );

  const stop = useCallback(
    (token: string) => {
      const role =
        REVIEW_ROLES.find(
          (r) =>
            r.id ===
            rowsRef.current.find((row) => row.token === token)?.docs_role,
        )?.label ?? "review";
      act(async (scope) => {
        await revokeHostShare(scope.projectPath, token);
        if (!isCurrent(scope)) return;
        announce(`Stopped sharing the ${role} link`);
        await load(scope);
      });
    },
    [act, announce, isCurrent, load],
  );

  const endRoom = useCallback(
    (sessionId: string) =>
      act(async (scope) => {
        await revokeHostRoom(scope.projectPath, sessionId);
        if (!isCurrent(scope)) return;
        announce("Record room ended");
        await load(scope);
      }),
    [act, announce, isCurrent, load],
  );

  const value = useMemo<ShareFlow>(
    () => ({
      rows,
      loaded,
      choices,
      setChoices,
      busy,
      recovery,
      error,
      status,
      copiedKey,
      blockedKey,
      reload,
      create,
      refreshMix,
      copy,
      stop,
      createRecord,
      replaceInvite,
      endRoom,
    }),
    [
      rows,
      loaded,
      choices,
      busy,
      recovery,
      error,
      status,
      copiedKey,
      blockedKey,
      reload,
      create,
      refreshMix,
      copy,
      stop,
      createRecord,
      replaceInvite,
      endRoom,
    ],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
