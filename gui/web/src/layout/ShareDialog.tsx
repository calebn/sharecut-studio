import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHostRecordRoom,
  createHostShare,
  listHostShares,
  revokeHostRoom,
  revokeHostShare,
} from "../api";
import { execute } from "../commands/execute";
import type { ExecuteResult } from "../commands/types";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { HostShareRow, ShareRole } from "../types/shares";
import { ApiError, errorMessage } from "../utils/apiError";
import { type ShareCreateRecovery, ShareDialogView } from "./ShareDialogView";
import { type ShareCopiedKey, shareCopyKey } from "./shareCopyKey";

const COPIED_MS = 2000;

type BusyOp = "create" | "refresh" | "revoke" | "record" | "end-room";
type ShareCreateRequest = {
  projectPath: string;
  role: ShareRole;
  withMcp: boolean;
  dialogGeneration: number;
  projectEpoch: number;
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
  const [role, setRole] = useState<ShareRole>("commenter");
  const [withMcp, setWithMcp] = useState(false);
  const [rows, setRows] = useState<HostShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(null);
  const [createRecovery, setCreateRecovery] = useState<ShareCreateRecovery>({
    kind: "idle",
  });
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGen = useRef(0);
  const dialogGen = useRef(0);
  const busyOp = useRef<BusyOp | null>(null);
  const staleCreateRequest = useRef<ShareCreateRequest | null>(null);

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

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    try {
      const data = await listHostShares(projectPath);
      if (gen !== loadGen.current) {
        return;
      }
      setRows(data.shares);
    } catch (err) {
      if (gen !== loadGen.current) {
        return;
      }
      throw err;
    }
  }, [projectPath]);

  useEffect(() => {
    return () => {
      clearCopiedTimer();
    };
  }, [clearCopiedTimer]);

  useEffect(() => {
    if (!shareDialogOpen) {
      loadGen.current += 1;
      dialogGen.current += 1;
      busyOp.current = null;
      staleCreateRequest.current = null;
      setCreateRecovery({ kind: "idle" });
      return;
    }
    dialogGen.current += 1;
    busyOp.current = null;
    staleCreateRequest.current = null;
    setRole("commenter");
    setWithMcp(false);
    setError(null);
    setStatus(null);
    setBusy(false);
    clearCopiedTimer();
    setCopiedKey(null);
    setCreateRecovery({ kind: "idle" });
    void load().catch((err: unknown) => {
      setError(errorMessage(err));
    });
  }, [shareDialogOpen, projectEpoch, load, clearCopiedTimer]);

  function captureCreateRequest(): ShareCreateRequest {
    return {
      projectPath,
      role,
      withMcp,
      dialogGeneration: dialogGen.current,
      projectEpoch,
    };
  }

  function isCurrentRequest(request: ShareCreateRequest): boolean {
    const current = useDawStore.getState();
    return (
      request.dialogGeneration === dialogGen.current &&
      request.projectEpoch === current.projectEpoch &&
      request.projectPath === current.projectPath &&
      current.shareDialogOpen
    );
  }

  async function createShare(request: ShareCreateRequest): Promise<void> {
    try {
      const share = await createHostShare(request.projectPath, {
        role: request.role,
        with_mcp: request.withMcp,
      });
      if (!isCurrentRequest(request)) {
        return;
      }
      staleCreateRequest.current = null;
      setCreateRecovery({ kind: "idle" });
      if (share.url) {
        try {
          await copyText(share.url);
          if (!isCurrentRequest(request)) {
            return;
          }
          markCopied(shareCopyKey("link", share.token));
          announce("Share link created and copied");
        } catch (err) {
          if (!isCurrentRequest(request)) {
            return;
          }
          announce("Share link created");
          setError(errorMessage(err));
        }
      } else {
        announce("Share link created");
      }
      await load();
    } catch (err) {
      if (!isCurrentRequest(request)) {
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
    if (busyOp.current) {
      return;
    }
    const op: BusyOp = "create";
    const request = captureCreateRequest();
    busyOp.current = op;
    setBusy(true);
    setError(null);
    setStatus(null);
    staleCreateRequest.current = null;
    setCreateRecovery({ kind: "idle" });
    try {
      await createShare(request);
    } finally {
      if (busyOp.current === op && isCurrentRequest(request)) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  async function onRefreshMix() {
    if (busyOp.current || createRecovery.kind !== "stale_mix") {
      return;
    }
    const op: BusyOp = "refresh";
    const { message } = createRecovery;
    const staleRequest = staleCreateRequest.current;
    if (!staleRequest || !isCurrentRequest(staleRequest)) {
      return;
    }
    const retryRequest = staleRequest;
    busyOp.current = op;
    setBusy(true);
    setError(null);
    setCreateRecovery({ kind: "refreshing" });
    try {
      if (!isCurrentRequest(retryRequest)) {
        return;
      }
      let result: ExecuteResult;
      try {
        result = await execute("render.refreshMix");
      } catch (err) {
        if (isCurrentRequest(retryRequest)) {
          setCreateRecovery({
            kind: "stale_mix",
            message,
            refreshError: errorMessage(err),
          });
        }
        return;
      }
      if (!isCurrentRequest(retryRequest)) {
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
      if (busyOp.current === op && isCurrentRequest(retryRequest)) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  async function onCreateRecord() {
    if (busyOp.current) {
      return;
    }
    const op: BusyOp = "record";
    busyOp.current = op;
    const gen = dialogGen.current;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const room = await createHostRecordRoom(projectPath);
      if (gen !== dialogGen.current) {
        return;
      }
      if (room.guest.url) {
        try {
          await copyText(room.guest.url);
          markCopied(shareCopyKey("link", room.guest.token));
          announce("Record links created and guest link copied");
        } catch (err) {
          announce("Record links created");
          setError(errorMessage(err));
        }
      } else {
        announce("Record links created");
      }
      await load();
    } catch (err) {
      if (gen !== dialogGen.current) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (busyOp.current === op && gen === dialogGen.current) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  async function copyRow(
    kind: "link" | "mcp",
    token: string,
    label: string,
    text: string | null,
  ) {
    if (!text) {
      return;
    }
    setError(null);
    try {
      await copyText(text);
      markCopied(shareCopyKey(kind, token));
      announce(`${label} copied`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onRevoke(token: string) {
    if (!window.confirm(`Stop sharing ${token}?`)) {
      return;
    }
    const op: BusyOp = "revoke";
    busyOp.current = op;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await revokeHostShare(projectPath, token);
      announce("Share link stopped");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (busyOp.current === op) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  async function onEndRoom(sessionId: string) {
    if (busyOp.current) {
      return;
    }
    if (
      !window.confirm(
        "End this record room? Both guest and producer links will stop working.",
      )
    ) {
      return;
    }
    const op: BusyOp = "end-room";
    busyOp.current = op;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await revokeHostRoom(projectPath, sessionId);
      announce("Record room ended");
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (busyOp.current === op) {
        busyOp.current = null;
        setBusy(false);
      }
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
      onCreate={() => void onCreate()}
      onRefreshMix={() => void onRefreshMix()}
      onCreateRecord={() => void onCreateRecord()}
      onCopy={(kind, token, label, text) =>
        void copyRow(kind, token, label, text)
      }
      onRevoke={(token) => void onRevoke(token)}
      onEndRoom={(sessionId) => void onEndRoom(sessionId)}
      onOpenRoomPanel={() => {
        setShareDialogOpen(false);
        void execute("record.openPanel");
      }}
    />
  );
}
