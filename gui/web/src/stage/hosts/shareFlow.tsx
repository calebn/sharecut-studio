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
  type HostRevoked,
  listHostShares,
  replaceHostRecordInvite,
  restoreHostRoom,
  restoreHostShare,
  restoreRefusal,
  revokeHostRoom,
  revokeHostShare,
} from "../../api";
import { execute } from "../../commands/execute";
import type { ExecuteResult } from "../../commands/types";
import { useHasFeature } from "../../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_MENU,
  FEATURE_TUNNEL_STATUS,
} from "../../extensions/features";
import {
  copyText,
  endRoomCheck,
  STALE_ROOM_LINKS_WARNING,
  useHostRoomReader,
  useRecordHostStore,
} from "../../record";
import {
  createRecoveryOf,
  SHARE_DEFAULTS,
  type ShareChoices,
  type ShareCopiedKey,
  type ShareCopyKind,
  type ShareCreateRecovery,
  shareCopyKey,
  shareWarning,
} from "../../stages/deliver/shareLogic";
import { useDawStore } from "../../state/dawStore";
import type { ReverseAction } from "../../state/types";
import type { HostShareRow } from "../../types/shares";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { errorMessage } from "../../utils/apiError";
import { useStableCallback } from "../../utils/useStableCallback";
import { copyWhenReady } from "./copyWhenReady";
import { Flow, type ShareFlow } from "./shareFlowContext";
import {
  LINK_UNDO,
  ROOM_UNDO,
  refusalCopy,
  type UndoCopy,
  undoDwellMs,
} from "./shareUndo";
import { useTunnelStatus } from "./useTunnelStatus";

const COPIED_MS = 2000;
const UNDO_STILL_OPEN = "Undo is still available.";

/** The project and visit a result belongs to; anything else is dropped. */
type Scope = {
  projectPath: string;
  projectEpoch: number;
  generation: number;
};

type CreateRequest = {
  scope: Scope;
  choices: ShareChoices;
  /** The listen link, made from the Deliver row or the sheet's Listen group. */
  listen: boolean;
};
type Owner = { scope: Scope; kind: "visit" | "end" };
type Ending =
  | { kind: "link"; token: string }
  | { kind: "room"; sessionId: string };

function shareUndoOpen() {
  const state = useDawStore.getState();
  const share = state.feedbackToast?.reverse?.share;
  return (
    share !== undefined &&
    share.projectPath === state.projectPath &&
    share.projectEpoch === state.projectEpoch &&
    Date.now() < share.deadline
  );
}

const NO_ADDRESS = new Error("The link has no address to copy yet.");
const ABANDONED = new Error(
  "The project or stage changed before the link arrived.",
);

/** Where the links are on show: the Deliver stage's listen link, or the Invite sheet over any stage. */
function sharesShown(s: { stage: string; openSheet: string | null }): boolean {
  return s.stage === "deliver" || s.openSheet === "invite";
}

/** What a link is called in the status line. */
function linkNameOf(request: CreateRequest): string {
  return request.listen ? "Listen link" : "Review link";
}

/**
 * The host's review links and record rooms, outside any stage so a result
 * that arrives after a click is still tied to the project and visit that made
 * it. An accepted end still reports to the same project after its surface
 * closes. Other results belong to their visit, and the list reloads as needed.
 */
export function ShareFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const onDeliver = useDawStore(sharesShown);
  const announceStatus = useDawStore((s) => s.announceStatus);
  const [rows, setRows] = useState<readonly HostShareRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const [choices, setChoices] = useState<ShareChoices>(SHARE_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(null);
  const [blockedKey, setBlockedKey] = useState<ShareCopiedKey | null>(null);
  const [recovery, setRecovery] = useState<ShareCreateRecovery>({
    kind: "idle",
  });
  const [refreshFor, setRefreshFor] = useState<{
    choices: ShareChoices;
    listen: boolean;
  } | null>(null);
  const mounted = useRef(true);
  const listFailure = useRef<string | null>(null);
  const generation = useRef(0);
  const loadGeneration = useRef(0);
  const busyOwner = useRef<Owner | null>(null);
  const staleRequest = useRef<CreateRequest | null>(null);
  const endFocus = useRef<{
    target: Ending;
    heading: HTMLElement;
    trigger: Element | null;
    fallback: HTMLElement | null;
  } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRows = useStableCallback(() => rows);
  const readHostRoom = useHostRoomReader();
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
      announceStatus(message, shareUndoOpen() ? { toast: false } : undefined);
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

  const isSameProject = useCallback((scope: Scope): boolean => {
    const s = useDawStore.getState();
    return (
      mounted.current &&
      scope.projectPath === s.projectPath &&
      scope.projectEpoch === s.projectEpoch &&
      s.project !== null
    );
  }, []);

  const isCurrent = useCallback(
    (scope: Scope): boolean =>
      isSameProject(scope) &&
      scope.generation === generation.current &&
      sharesShown(useDawStore.getState()),
    [isSameProject],
  );

  const begin = useCallback(
    (scope: Scope, kind: Owner["kind"] = "visit"): Owner | null => {
      if (!isCurrent(scope) || busyOwner.current !== null) return null;
      const owner: Owner = { scope, kind };
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
      if (isSameProject(owner.scope)) setBusy(false);
    },
    [isSameProject],
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
        setListFailed(false);
        setError((shown) => (shown === listFailure.current ? null : shown));
      } catch (err) {
        if (mine === loadGeneration.current && isCurrent(scope)) {
          endFocus.current = null;
          setListFailed(true);
          listFailure.current = errorMessage(err);
          setError(listFailure.current);
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
        sharesShown(s)
      ) {
        void load(scopeNow());
      }
    },
    [load, scopeNow],
  );

  // Leaving the surface ends the visit. An accepted end belongs to the project.
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
    if (!sameProject || busyOwner.current?.kind !== "end")
      busyOwner.current = null;
    endFocus.current = null;
    staleRequest.current = null;
    clearCopiedTimer();
    setBusy(busyOwner.current !== null);
    setError(null);
    setStatus(null);
    setCopiedKey(null);
    setBlockedKey(null);
    setRecovery({ kind: "idle" });
    setRefreshFor(null);
    setChoices(SHARE_DEFAULTS);
    if (!sameProject) {
      setRows([]);
      setLoaded(false);
      setListFailed(false);
    }
  }, [projectPath, projectEpoch, onDeliver, clearCopiedTimer]);

  useLayoutEffect(() => {
    const end = endFocus.current;
    if (!end) return;
    if (!isValidFocusTarget(end.heading)) {
      endFocus.current = null;
      return;
    }
    if (
      rows.some(
        (row) =>
          row.usable &&
          (end.target.kind === "link"
            ? row.token === end.target.token
            : row.session_id === end.target.sessionId),
      )
    ) {
      return;
    }
    endFocus.current = null;
    const active = document.activeElement;
    if (
      active === end.trigger ||
      active === document.body ||
      active === end.fallback
    )
      end.heading.focus({ preventScroll: true });
  }, [rows]);

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

  // One poller and one list for every surface: the links are listed again, and
  // online sharing is polled, while Deliver or the Invite sheet shows them.
  const shareOffered = useHasFeature(FEATURE_SHARE_UI_MENU);
  const tunnelOffered = useHasFeature(FEATURE_TUNNEL_STATUS);
  const tunnelPolled = shareOffered && tunnelOffered && onDeliver;
  const tunnel = useTunnelStatus(tunnelPolled);
  const tunnelPending = tunnelPolled && tunnel === null;
  useEffect(() => {
    if (!onDeliver || !shareOffered || !projectPath) return;
    reload();
  }, [onDeliver, shareOffered, projectPath, projectEpoch, reload]);

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
          setRefreshFor({ choices: request.choices, listen: request.listen });
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
          announce(`${linkNameOf(request)} created and copied`);
        } catch {
          if (!isCurrent(request.scope)) return;
          setBlockedKey(shareCopyKey("link", share.token));
          announce(
            `${linkNameOf(request)} created. Your browser would not copy it, so it is selected: copy it with the keyboard.`,
          );
        }
      } else {
        announce(`${linkNameOf(request)} created`);
      }
      await load(request.scope);
      const warning = shareWarning(share);
      if (warning && isCurrent(request.scope)) setError(warning);
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

  const create = useStableCallback((override?: ShareChoices) => {
    const request: CreateRequest = {
      scope: scopeNow(),
      choices: override ?? choices,
      listen: override !== undefined,
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
  });

  const refreshMix = useStableCallback(() => {
    const current = recovery;
    if (current.kind !== "needs_refresh") return;
    const { message } = current;
    const stale = staleRequest.current;
    if (!stale || !isCurrent(stale.scope)) return;
    const retry: CreateRequest = {
      scope: stale.scope,
      // The listen link retries as itself; a review link, as the choices now shown.
      choices: stale.listen ? stale.choices : choices,
      listen: stale.listen,
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
      } catch (err) {
        if (isCurrent(retry.scope)) setError(errorMessage(err));
      } finally {
        finish(owner);
      }
    })();
  });

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
        const notes = [
          shareWarning(room.guest),
          room.linksStale ? STALE_ROOM_LINKS_WARNING : null,
        ].filter((note) => note !== null);
        if (notes.length > 0 && isCurrent(scope)) {
          setError((now) => [now, ...notes].filter(Boolean).join(" "));
        }
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
          const warning = shareWarning(share);
          if (warning && isCurrent(scope)) {
            setError((now) => (now ? `${now} ${warning}` : warning));
          }
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
          const onRow = currentRows().some(
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
    [announce, isCurrent, markCopied, scopeNow, currentRows],
  );

  /**
   * Says an end happened and, while the server still honors it, offers Undo.
   * The server owns the window: the toast only leaves a little sooner.
   */
  const announceEnded = useCallback(
    (
      copy: UndoCopy,
      what: "link" | "room",
      ended: HostRevoked,
      restore: () => Promise<void>,
      scope: Scope,
      focus?: () => HTMLElement | null,
      onSettled?: () => void,
    ) => {
      const dwellMs = undoDwellMs(ended.restoreMs);
      if (dwellMs === null) {
        announceStatus(copy.ended);
        return;
      }
      const reverse: ReverseAction = {
        done: copy.restored,
        share: {
          projectPath: scope.projectPath,
          projectEpoch: scope.projectEpoch,
          deadline: Date.now() + dwellMs,
        },
        run: async () => {
          try {
            await restore();
          } catch (err) {
            const code = restoreRefusal(err);
            if (code === null) throw err;
            return refusalCopy(code, what);
          } finally {
            onSettled?.();
          }
          relist(scope);
          return true;
        },
      };
      announceStatus(copy.ended, { dwellMs, reverse, returnFocus: focus });
    },
    [announceStatus, relist],
  );

  const ignoreEnd = useCallback(() => {
    setStatus(UNDO_STILL_OPEN);
    announceStatus(UNDO_STILL_OPEN, { toast: false });
  }, [announceStatus]);

  const shownReverse = useDawStore((s) => s.feedbackToast?.reverse ?? null);
  useEffect(() => {
    if (!shownReverse?.share)
      setStatus((now) => (now === UNDO_STILL_OPEN ? null : now));
  }, [shownReverse]);

  const end = useCallback(
    (target: Ending, focus?: () => HTMLElement | null) => {
      if (shareUndoOpen()) {
        ignoreEnd();
        return false;
      }
      const scope = scopeNow();
      const room = target.kind === "room" ? target.sessionId : null;
      const recheck = () => readHostRoom()?.recheck();
      if (room !== null) {
        const check = endRoomCheck(
          useRecordHostStore.getState().snapshot,
          readHostRoom()?.hostSegments ?? null,
          room,
        );
        if (check.kind === "blocked") {
          if (isCurrent(scope)) setError(check.reason);
          recheck();
          return false;
        }
      }
      const owner = begin(scope, "end");
      if (!owner) return false;
      const heading = focus?.() ?? null;
      const trigger = document.activeElement;
      void (async () => {
        const path = scope.projectPath;
        try {
          const ended = await (target.kind === "link"
            ? revokeHostShare(path, target.token, { restorable: true })
            : revokeHostRoom(path, target.sessionId, { restorable: true }));
          if (!isSameProject(scope)) return;
          if (room !== null) {
            const hostRoom = readHostRoom();
            if (hostRoom) hostRoom.forgetRoom(room);
            else useRecordHostStore.getState().markEnded(room);
            recheck();
          }
          if (heading && isCurrent(scope)) {
            // Deliver may put focus on its root when the menu closes.
            const fallback =
              heading.parentElement?.closest<HTMLElement>('[tabindex="-1"]') ??
              null;
            endFocus.current = { target, heading, trigger, fallback };
          }
          announceEnded(
            target.kind === "link" ? LINK_UNDO : ROOM_UNDO,
            target.kind,
            ended,
            async () => {
              if (target.kind === "link") {
                await restoreHostShare(path, target.token);
                return;
              }
              await restoreHostRoom(path, target.sessionId);
              useRecordHostStore.getState().liftEnded(target.sessionId);
            },
            scope,
            () => {
              if (!isSameProject(scope)) return null;
              const origin = focus?.() ?? heading;
              return isValidFocusTarget(origin) ? origin : null;
            },
            room !== null ? recheck : undefined,
          );
          await load(scopeNow());
        } catch (err) {
          if (room !== null) recheck();
          if (isCurrent(scope)) setError(errorMessage(err));
        } finally {
          finish(owner);
        }
      })();
      return true;
    },
    [
      announceEnded,
      begin,
      finish,
      ignoreEnd,
      isCurrent,
      isSameProject,
      load,
      readHostRoom,
      scopeNow,
    ],
  );

  const stop = useCallback(
    (token: string, focus?: () => HTMLElement | null) =>
      end({ kind: "link", token }, focus),
    [end],
  );

  const endRoom = useCallback(
    (sessionId: string, focus?: () => HTMLElement | null) =>
      end({ kind: "room", sessionId }, focus),
    [end],
  );

  const value = useMemo<ShareFlow>(
    () => ({
      rows,
      loaded,
      listFailed,
      choices,
      setChoices,
      busy,
      recovery,
      refreshFor,
      error,
      status,
      copiedKey,
      blockedKey,
      tunnel,
      tunnelPending,
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
      listFailed,
      choices,
      busy,
      recovery,
      refreshFor,
      error,
      status,
      copiedKey,
      blockedKey,
      tunnel,
      tunnelPending,
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
