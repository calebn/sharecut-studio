import { useCallback, useEffect, useRef, useState } from "react";
import {
  createHostRecordRoom,
  createHostShare,
  listHostShares,
  revokeHostRoom,
  revokeHostShare,
} from "../api";
import { execute } from "../commands/execute";
import { useDaw } from "../state/useDaw";
import type { HostShareRow, ShareRole } from "../types/shares";
import { errorMessage } from "../utils/apiError";
import { ShareDialogView } from "./ShareDialogView";
import { type ShareCopiedKey, shareCopyKey } from "./shareCopyKey";

const COPIED_MS = 2000;

type BusyOp = "create" | "revoke" | "record" | "end-room";

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
    announceStatus,
  } = useDaw((s) => ({
    shareDialogOpen: s.shareDialogOpen,
    setShareDialogOpen: s.setShareDialogOpen,
    project: s.project,
    projectPath: s.projectPath,
    announceStatus: s.announceStatus,
  }));
  const [role, setRole] = useState<ShareRole>("commenter");
  const [withMcp, setWithMcp] = useState(false);
  const [rows, setRows] = useState<HostShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<ShareCopiedKey | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGen = useRef(0);
  const dialogGen = useRef(0);
  const busyOp = useRef<BusyOp | null>(null);

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
      return;
    }
    setRole("commenter");
    setWithMcp(false);
    setError(null);
    setStatus(null);
    setBusy(false);
    clearCopiedTimer();
    setCopiedKey(null);
    void load().catch((err: unknown) => {
      setError(errorMessage(err));
    });
  }, [shareDialogOpen, load, clearCopiedTimer]);

  async function onCreate() {
    const op: BusyOp = "create";
    busyOp.current = op;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const share = await createHostShare(projectPath, {
        role,
        with_mcp: withMcp,
      });
      if (share.url) {
        try {
          await copyText(share.url);
          markCopied(shareCopyKey("link", share.token));
          announce("Share link created and copied");
        } catch (err) {
          announce("Share link created");
          setError(errorMessage(err));
        }
      } else {
        announce("Share link created");
      }
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
      error={error}
      status={status}
      copiedKey={copiedKey}
      onCreate={() => void onCreate()}
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
