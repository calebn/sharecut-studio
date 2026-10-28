import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  createHostShare,
  listHostShares,
  replaceHostRecordInvite,
  revokeHostRoom,
  revokeHostShare,
} from "../../api";
import { execute } from "../../commands/execute";
import type { ExecuteResult } from "../../commands/types";
import { useHasFeature } from "../../extensions/FeaturesContext";
import { FEATURE_TUNNEL_STATUS } from "../../extensions/features";
import { copyText, createRecordRoomAndCopyGuestLink } from "../../record";
import type {
  ShareCreateRecovery,
  ShareLastCreated,
} from "../../stages/deliver/shareLogic";
import {
  type ShareCopiedKey,
  shareCopyKey,
} from "../../stages/deliver/shareLogic";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import {
  type HostShareRow,
  REVIEW_ROLES,
  type ShareRole,
} from "../../types/shares";
import { ApiError, errorMessage } from "../../utils/apiError";
import { useTunnelStatus } from "../dialogs/useTunnelStatus";

const COPIED_MS = 2000;

/** API error codes whose fix is Refresh mix, with the copy that pairs each with it. */
const REFRESH_MIX_MESSAGES: ReadonlyMap<string, string> = new Map([
  [
    "no_mix",
    "This project has no mix yet. Refresh the mix to create the link.",
  ],
  [
    "stale_mix",
    "The mix preview is out of date. Refresh it before creating a review link.",
  ],
]);

type ShareScope = {
  projectPath: string;
  projectEpoch: number;
  generation: number;
};
type ShareCreateRequest = {
  scope: ShareScope;
  role: ShareRole;
  withMcp: boolean;
  freeze: boolean;
};
type BusyOwner = {
  scope: ShareScope;
};

/**
 * The host's share links for the open project: the review links and record
 * rooms, creating, copying and ending them, and the online sharing status.
 * Everything is scoped to `active`, the project path and the project epoch, so
 * an answer that arrives after any of them changed is dropped.
 */
export function useShareFlow(active: boolean) {
  const { projectPath, projectEpoch, announceStatus } = useDaw((s) => ({
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    announceStatus: s.announceStatus,
  }));
  const tunnel = useTunnelStatus(
    useHasFeature(FEATURE_TUNNEL_STATUS) && active,
  );
  const [role, setRole] = useState<ShareRole>("commenter");
  const [withMcp, setWithMcp] = useState(false);
  const [freeze, setFreeze] = useState(false);
  const [rows, setRows] = useState<HostShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(null);
  const [lastCreated, setLastCreated] = useState<ShareLastCreated | null>(null);
  const [createRecovery, setCreateRecovery] = useState<ShareCreateRecovery>({
    kind: "idle",
  });
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGen = useRef(0);
  const dialogGen = useRef(0);
  const busyOwner = useRef<BusyOwner | null>(null);
  const staleCreateRequest = useRef<ShareCreateRequest | null>(null);
  const scopeRef = useRef({ projectPath, projectEpoch, active });

  const clearCopiedTimer = useCallback(() => {
    if (copiedTimer.current) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
  }, []);

  const markCopied = useCallback(
    (key: ShareCopiedKey) => {
      clearCopiedTimer();
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

  const captureScope = useCallback(
    (): ShareScope => ({
      projectPath,
      projectEpoch,
      generation: dialogGen.current,
    }),
    [projectPath, projectEpoch],
  );

  const isCurrentScope = useCallback((scope: ShareScope): boolean => {
    const state = useDawStore.getState();
    const current = scopeRef.current;
    return (
      scope.generation === dialogGen.current &&
      scope.projectPath === current.projectPath &&
      scope.projectEpoch === current.projectEpoch &&
      current.active &&
      scope.projectPath === state.projectPath &&
      scope.projectEpoch === state.projectEpoch &&
      state.project !== null
    );
  }, []);

  const beginOperation = useCallback(
    (scope: ShareScope) => {
      if (!isCurrentScope(scope) || busyOwner.current !== null) {
        return null;
      }
      const owner: BusyOwner = { scope };
      busyOwner.current = owner;
      setBusy(true);
      setError(null);
      setStatus(null);
      return owner;
    },
    [isCurrentScope],
  );

  const finishOperation = useCallback(
    (owner: BusyOwner) => {
      if (busyOwner.current !== owner) {
        return;
      }
      busyOwner.current = null;
      if (isCurrentScope(owner.scope)) {
        setBusy(false);
      }
    },
    [isCurrentScope],
  );

  const load = useCallback(
    async (scope: ShareScope) => {
      if (!isCurrentScope(scope)) {
        return;
      }
      const gen = ++loadGen.current;
      try {
        const data = await listHostShares(scope.projectPath);
        if (gen !== loadGen.current || !isCurrentScope(scope)) {
          return;
        }
        setRows(data.shares);
      } catch (err) {
        if (gen === loadGen.current && isCurrentScope(scope)) {
          setError(errorMessage(err));
        }
      }
    },
    [isCurrentScope],
  );

  useLayoutEffect(() => {
    const previous = scopeRef.current;
    if (
      previous.projectPath === projectPath &&
      previous.projectEpoch === projectEpoch &&
      previous.active === active
    ) {
      return;
    }
    dialogGen.current += 1;
    loadGen.current += 1;
    busyOwner.current = null;
    staleCreateRequest.current = null;
    setRows([]);
    setBusy(false);
    setError(null);
    setStatus(null);
    setCreateRecovery({ kind: "idle" });
    clearCopiedTimer();
    setCopiedKey(null);
    setLastCreated(null);
    scopeRef.current = { projectPath, projectEpoch, active };
  }, [projectPath, projectEpoch, active, clearCopiedTimer]);

  useEffect(() => {
    return () => {
      clearCopiedTimer();
      dialogGen.current += 1;
      loadGen.current += 1;
      busyOwner.current = null;
    };
  }, [clearCopiedTimer]);

  useEffect(() => {
    if (!active) {
      return;
    }
    setRole("commenter");
    setWithMcp(false);
    setFreeze(false);
    setError(null);
    setStatus(null);
    setCreateRecovery({ kind: "idle" });
    const scope = captureScope();
    void load(scope);
  }, [active, projectPath, projectEpoch, captureScope, load]);

  async function createShare(request: ShareCreateRequest): Promise<void> {
    try {
      const share = await createHostShare(request.scope.projectPath, {
        role: request.role,
        with_mcp: request.withMcp,
        ...(request.freeze ? { freeze: true } : {}),
      });
      if (!isCurrentScope(request.scope)) {
        return;
      }
      staleCreateRequest.current = null;
      setCreateRecovery({ kind: "idle" });
      if (share.url) {
        setLastCreated({ token: share.token, url: share.url, kind: "review" });
        try {
          await copyText(share.url);
          if (!isCurrentScope(request.scope)) {
            return;
          }
          markCopied(shareCopyKey("link", share.token));
          announce("Review link created and copied");
        } catch (err) {
          if (!isCurrentScope(request.scope)) {
            return;
          }
          announce("Review link created");
          setError(errorMessage(err));
        }
      } else {
        announce("Review link created");
      }
      await load(request.scope);
      const corsWarning = share.warnings?.find(
        (w) => w.code === "object_store_cors",
      );
      if (corsWarning && isCurrentScope(request.scope)) {
        setError(
          `Link created, but its bucket has no CORS rule for ${corsWarning.origin ?? "the share origin"}, so guests stream through your connection until you add one. The rule to paste is in docs/host-online-relay.md.`,
        );
      }
    } catch (err) {
      if (!isCurrentScope(request.scope)) {
        return;
      }
      const refreshMessage =
        err instanceof ApiError && err.code
          ? REFRESH_MIX_MESSAGES.get(err.code)
          : undefined;
      if (refreshMessage) {
        staleCreateRequest.current = request;
        setCreateRecovery({
          kind: "needs_refresh",
          message: refreshMessage,
          refreshError: null,
        });
      } else if (err instanceof ApiError && err.code === "stale_master") {
        staleCreateRequest.current = null;
        setCreateRecovery({ kind: "idle" });
        setError(
          "The mastered mix is out of date. Export a new master before creating a review link.",
        );
      } else {
        staleCreateRequest.current = null;
        setCreateRecovery({ kind: "idle" });
        setError(errorMessage(err));
      }
    }
  }

  async function onCreate() {
    const request: ShareCreateRequest = {
      scope: captureScope(),
      role,
      withMcp,
      freeze,
    };
    const owner = beginOperation(request.scope);
    if (!owner) {
      return;
    }
    staleCreateRequest.current = null;
    setCreateRecovery({ kind: "idle" });
    try {
      await createShare(request);
    } finally {
      finishOperation(owner);
    }
  }

  async function onRefreshMix() {
    if (createRecovery.kind !== "needs_refresh") {
      return;
    }
    const { message } = createRecovery;
    const staleRequest = staleCreateRequest.current;
    if (!staleRequest || !isCurrentScope(staleRequest.scope)) {
      return;
    }
    const retryRequest = staleRequest;
    const owner = beginOperation(retryRequest.scope);
    if (!owner) {
      return;
    }
    setCreateRecovery({ kind: "refreshing" });
    try {
      if (!isCurrentScope(retryRequest.scope)) {
        return;
      }
      let result: ExecuteResult;
      try {
        result = await execute("render.refreshMix");
      } catch (err) {
        if (isCurrentScope(retryRequest.scope)) {
          setCreateRecovery({
            kind: "needs_refresh",
            message,
            refreshError: errorMessage(err),
          });
        }
        return;
      }
      if (!isCurrentScope(retryRequest.scope)) {
        return;
      }
      if (result.status !== "ok") {
        setCreateRecovery({
          kind: "needs_refresh",
          message,
          refreshError:
            result.status === "disabled"
              ? result.reason
              : "Refresh mix is unavailable",
        });
        return;
      }
      setCreateRecovery({ kind: "retrying" });
      await createShare(retryRequest);
    } finally {
      finishOperation(owner);
    }
  }

  async function onCreateRecord() {
    const scope = captureScope();
    const owner = beginOperation(scope);
    if (!owner) {
      return;
    }
    try {
      const { room, copied, copyError } =
        await createRecordRoomAndCopyGuestLink(scope.projectPath);
      if (!isCurrentScope(scope)) {
        return;
      }
      if (room.guest.url) {
        setLastCreated({
          token: room.guest.token,
          url: room.guest.url,
          kind: "guest",
        });
      }
      if (copied) {
        markCopied(shareCopyKey("link", room.guest.token));
        announce("Record links created and guest link copied");
      } else {
        announce("Record links created");
        if (copyError) {
          setError(copyError);
        }
      }
      if (isCurrentScope(scope)) {
        await load(scope);
      }
    } catch (err) {
      if (isCurrentScope(scope)) {
        setError(errorMessage(err));
      }
    } finally {
      finishOperation(owner);
    }
  }

  async function onReplaceRecordInvite(sourceToken: string) {
    const scope = captureScope();
    const owner = beginOperation(scope);
    if (!owner) {
      return;
    }
    try {
      const share = await replaceHostRecordInvite(
        scope.projectPath,
        sourceToken,
      );
      if (!isCurrentScope(scope)) {
        return;
      }
      if (share.url) {
        try {
          await copyText(share.url);
          if (!isCurrentScope(scope)) {
            return;
          }
          markCopied(shareCopyKey("link", share.token));
          announce(
            `${share.record_role === "producer" ? "Producer" : "Guest"} link replaced and copied`,
          );
        } catch (err) {
          if (!isCurrentScope(scope)) {
            return;
          }
          announce("Record invite replaced");
          setError(errorMessage(err));
        }
      } else {
        if (!isCurrentScope(scope)) {
          return;
        }
        announce("Record invite replaced");
      }
      if (!isCurrentScope(scope)) {
        return;
      }
      await load(scope);
    } catch (err) {
      if (isCurrentScope(scope)) {
        setError(errorMessage(err));
      }
    } finally {
      finishOperation(owner);
    }
  }

  async function copyRow(
    kind: "link" | "mcp",
    token: string,
    label: string,
    text: string | null,
  ) {
    const scope = captureScope();
    if (!text || !isCurrentScope(scope)) {
      return;
    }
    setError(null);
    try {
      await copyText(text);
      if (!isCurrentScope(scope)) {
        return;
      }
      markCopied(shareCopyKey(kind, token));
      announce(`${label} copied`);
    } catch (err) {
      if (isCurrentScope(scope)) {
        setError(errorMessage(err));
      }
    }
  }

  async function onRevoke(token: string) {
    const role =
      REVIEW_ROLES.find(
        (r) => r.id === rows.find((row) => row.token === token)?.docs_role,
      )?.label ?? "review";
    const scope = captureScope();
    const owner = beginOperation(scope);
    if (!owner) {
      return;
    }
    try {
      await revokeHostShare(scope.projectPath, token);
      if (!isCurrentScope(scope)) {
        return;
      }
      announce(`Stopped sharing the ${role} link`);
      await load(scope);
    } catch (err) {
      if (isCurrentScope(scope)) {
        setError(errorMessage(err));
      }
    } finally {
      finishOperation(owner);
    }
  }

  async function onEndRoom(sessionId: string) {
    const scope = captureScope();
    const owner = beginOperation(scope);
    if (!owner) {
      return;
    }
    try {
      await revokeHostRoom(scope.projectPath, sessionId);
      if (!isCurrentScope(scope)) {
        return;
      }
      announce("Record room ended");
      await load(scope);
    } catch (err) {
      if (isCurrentScope(scope)) {
        setError(errorMessage(err));
      }
    } finally {
      finishOperation(owner);
    }
  }

  return {
    role,
    setRole,
    withMcp,
    setWithMcp,
    freeze,
    setFreeze,
    rows,
    busy,
    createRecovery,
    error,
    status,
    copiedKey,
    lastCreated,
    tunnel,
    create: () => void onCreate(),
    refreshMix: () => void onRefreshMix(),
    createRecord: () => void onCreateRecord(),
    copy: (
      kind: "link" | "mcp",
      token: string,
      label: string,
      text: string | null,
    ) => void copyRow(kind, token, label, text),
    revoke: (token: string) => void onRevoke(token),
    endRoom: (sessionId: string) => void onEndRoom(sessionId),
    replaceRecordInvite: (token: string) => void onReplaceRecordInvite(token),
    openRoomPanel: () => void execute("record.openPanel"),
  };
}
