import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
} from "../api";
import { execute } from "../commands/execute";
import type { ExecuteResult } from "../commands/types";
import { useHasFeature } from "../extensions/FeaturesContext";
import { FEATURE_TUNNEL_STATUS } from "../extensions/features";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import {
  type HostShareRow,
  REVIEW_ROLES,
  type ShareRole,
} from "../types/shares";
import { ApiError, errorMessage } from "../utils/apiError";
import {
  type ShareCreateRecovery,
  ShareDialogView,
  type ShareLastCreated,
} from "./ShareDialogView";
import { type ShareCopiedKey, shareCopyKey } from "./shareCopyKey";
import { useTunnelStatus } from "./useTunnelStatus";

const COPIED_MS = 2000;

type DialogScope = {
  projectPath: string;
  projectEpoch: number;
  generation: number;
};
type ShareCreateRequest = {
  scope: DialogScope;
  role: ShareRole;
  withMcp: boolean;
};
type BusyOwner = {
  scope: DialogScope;
};

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable");
  }
  await navigator.clipboard.writeText(text);
}

export function ShareDialog() {
  const {
    shareDialogOpen,
    setShareDialogOpen,
    project,
    projectPath,
    projectEpoch,
    announceStatus,
  } = useDaw((s) => ({
    shareDialogOpen: s.shareDialogOpen,
    setShareDialogOpen: s.setShareDialogOpen,
    project: s.project,
    projectPath: s.projectPath,
    projectEpoch: s.projectEpoch,
    announceStatus: s.announceStatus,
  }));
  const tunnel = useTunnelStatus(
    useHasFeature(FEATURE_TUNNEL_STATUS) && shareDialogOpen,
  );
  const [role, setRole] = useState<ShareRole>("commenter");
  const [withMcp, setWithMcp] = useState(false);
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
  const scopeRef = useRef({ projectPath, projectEpoch, shareDialogOpen });

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
    (): DialogScope => ({
      projectPath,
      projectEpoch,
      generation: dialogGen.current,
    }),
    [projectPath, projectEpoch],
  );

  const isCurrentScope = useCallback((scope: DialogScope): boolean => {
    const state = useDawStore.getState();
    const current = scopeRef.current;
    return (
      scope.generation === dialogGen.current &&
      scope.projectPath === current.projectPath &&
      scope.projectEpoch === current.projectEpoch &&
      current.shareDialogOpen &&
      scope.projectPath === state.projectPath &&
      scope.projectEpoch === state.projectEpoch &&
      state.shareDialogOpen &&
      state.project !== null
    );
  }, []);

  const beginOperation = useCallback(
    (scope: DialogScope) => {
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
    async (scope: DialogScope) => {
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
      previous.shareDialogOpen === shareDialogOpen
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
    scopeRef.current = { projectPath, projectEpoch, shareDialogOpen };
  }, [projectPath, projectEpoch, shareDialogOpen, clearCopiedTimer]);

  useEffect(() => {
    return () => {
      clearCopiedTimer();
      dialogGen.current += 1;
      loadGen.current += 1;
      busyOwner.current = null;
    };
  }, [clearCopiedTimer]);

  useEffect(() => {
    if (!shareDialogOpen) {
      return;
    }
    setRole("commenter");
    setWithMcp(false);
    setError(null);
    setStatus(null);
    setCreateRecovery({ kind: "idle" });
    const scope = captureScope();
    void load(scope);
  }, [
    shareDialogOpen,
    projectPath,
    projectEpoch,
    captureScope,
    load,
    isCurrentScope,
  ]);

  async function createShare(request: ShareCreateRequest): Promise<void> {
    try {
      const share = await createHostShare(request.scope.projectPath, {
        role: request.role,
        with_mcp: request.withMcp,
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
    } catch (err) {
      if (!isCurrentScope(request.scope)) {
        return;
      }
      if (err instanceof ApiError && err.code === "stale_mix") {
        staleCreateRequest.current = request;
        setCreateRecovery({
          kind: "stale_mix",
          message:
            "The mix preview is out of date. Refresh it before creating a review link.",
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
    if (createRecovery.kind !== "stale_mix") {
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
            kind: "stale_mix",
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
          kind: "stale_mix",
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
      const room = await createHostRecordRoom(scope.projectPath);
      if (!isCurrentScope(scope)) {
        return;
      }
      if (room.guest.url) {
        setLastCreated({
          token: room.guest.token,
          url: room.guest.url,
          kind: "guest",
        });
        try {
          await copyText(room.guest.url);
          if (!isCurrentScope(scope)) {
            return;
          }
          markCopied(shareCopyKey("link", room.guest.token));
          announce("Record links created and guest link copied");
        } catch (err) {
          if (!isCurrentScope(scope)) {
            return;
          }
          announce("Record links created");
          setError(errorMessage(err));
        }
      } else {
        announce("Record links created");
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

  return (
    <ShareDialogView
      open={shareDialogOpen && !!project}
      onClose={() => setShareDialogOpen(false)}
      role={role}
      onRoleChange={setRole}
      withMcp={withMcp}
      onWithMcpChange={setWithMcp}
      rows={rows}
      busy={busy}
      createRecovery={createRecovery}
      error={error}
      status={status}
      copiedKey={copiedKey}
      lastCreated={lastCreated}
      tunnel={tunnel}
      onCreate={() => void onCreate()}
      onRefreshMix={() => void onRefreshMix()}
      onCreateRecord={() => void onCreateRecord()}
      onCopy={(kind, token, label, text) =>
        void copyRow(kind, token, label, text)
      }
      onRevoke={(token) => void onRevoke(token)}
      onEndRoom={(sessionId) => void onEndRoom(sessionId)}
      onReplaceRecordInvite={(token) => void onReplaceRecordInvite(token)}
      onOpenRoomPanel={() => {
        setShareDialogOpen(false);
        void execute("record.openPanel");
      }}
    />
  );
}
