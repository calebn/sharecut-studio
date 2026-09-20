import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import { Button, Dialog, Field, InlineError } from "../ui";

const ROLES: { id: ShareRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "editor", label: "Editor" },
];

const COPIED_MS = 2000;

type CopiedKey = `${"link" | "mcp"}:${string}`;
type BusyOp = "create" | "revoke" | "record" | "end-room";

function copyKey(kind: "link" | "mcp", token: string): CopiedKey {
  return `${kind}:${token}`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString();
}

type RecordRoomGroup = {
  sessionId: string;
  guests: HostShareRow[];
  producers: HostShareRow[];
};

function groupRecordRooms(rows: HostShareRow[]): RecordRoomGroup[] {
  const map = new Map<string, RecordRoomGroup>();
  for (const row of rows) {
    const sid = row.session_id || row.token;
    const existing = map.get(sid) ?? {
      sessionId: sid,
      guests: [],
      producers: [],
    };
    if (row.record_role === "producer") {
      existing.producers.push(row);
    } else {
      existing.guests.push(row);
    }
    map.set(sid, existing);
  }
  return [...map.values()];
}

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
  } = useDaw();
  const roleId = useId();
  const mcpId = useId();
  const [role, setRole] = useState<ShareRole>("commenter");
  const [withMcp, setWithMcp] = useState(false);
  const [rows, setRows] = useState<HostShareRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<CopiedKey | null>(null);
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
    (key: CopiedKey) => {
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
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [shareDialogOpen, load, clearCopiedTimer]);

  const live = rows.filter((row) => row.usable);
  const reviewLive = live.filter((row) => row.kind !== "record");
  const recordRooms = groupRecordRooms(
    live.filter((row) => row.kind === "record"),
  );

  const recordHeadingId = useId();
  const reviewLinksHeadingId = useId();
  const recordRoomsHeadingId = useId();

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
          markCopied(copyKey("link", share.token));
          announce("Share link created and copied");
        } catch (err) {
          announce("Share link created");
          setError(err instanceof Error ? err.message : String(err));
        }
      } else {
        announce("Share link created");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          markCopied(copyKey("link", room.guest.token));
          announce("Record links created and guest link copied");
        } catch (err) {
          announce("Record links created");
          setError(err instanceof Error ? err.message : String(err));
        }
      } else {
        announce("Record links created");
      }
      await load();
    } catch (err) {
      if (gen !== dialogGen.current) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (busyOp.current === op && gen === dialogGen.current) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  async function onCopy(
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
      markCopied(copyKey(kind, token));
      announce(`${label} copied`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (busyOp.current === op) {
        busyOp.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <Dialog
      open={shareDialogOpen && !!project}
      onClose={() => setShareDialogOpen(false)}
      title="Share"
      panelClassName="share-dialog-panel"
    >
      <div className="share-dialog-body">
        <Field label="Anyone with the link" htmlFor={roleId}>
          <select
            id={roleId}
            className="share-dialog-select"
            value={role}
            disabled={busy}
            onChange={(e) => setRole(e.target.value as ShareRole)}
          >
            {ROLES.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="share-dialog-note">
          Anyone with view can see your cursor, selection, playhead, and
          viewport while they are in the session.
        </p>
        <label className="share-dialog-check" htmlFor={mcpId}>
          <input
            id={mcpId}
            type="checkbox"
            checked={withMcp}
            disabled={busy}
            onChange={(e) => setWithMcp(e.target.checked)}
          />
          Allow agent (MCP)
        </label>
        <div className="share-dialog-actions">
          <Button
            variant="primary"
            type="button"
            disabled={busy}
            onClick={() => void onCreate()}
          >
            Create link
          </Button>
        </div>
        <section aria-labelledby={recordHeadingId}>
          <h3 className="share-dialog-heading" id={recordHeadingId}>
            Record session
          </h3>
          <p className="share-dialog-note">
            Producer link is for a silent third party (monitor in a later
            build). Share it only with your producer. These GUI links do not
            expire; use CLI <code>--expires-at</code> when you need a deadline.
          </p>
          <div className="share-dialog-actions">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void onCreateRecord()}
            >
              Create record links
            </Button>
          </div>
        </section>
        <section aria-labelledby={reviewLinksHeadingId}>
          <h3 className="share-dialog-heading" id={reviewLinksHeadingId}>
            Review links
          </h3>
          <div className="share-dialog-scroller">
            {reviewLive.length === 0 ? (
              <p className="share-dialog-empty">No live review links.</p>
            ) : (
              <ul className="share-dialog-list">
                {reviewLive.map((row) => (
                  <li key={row.token} className="share-dialog-row">
                    <div className="share-dialog-row-main">
                      <span className="share-dialog-token">{row.token}</span>
                      <span className="share-dialog-meta">
                        {ROLES.find((r) => r.id === row.docs_role)?.label ??
                          row.docs_role}
                        {row.review_version_label
                          ? ` · ${row.review_version_label}`
                          : ""}
                        {row.last_used_at
                          ? ` · used ${formatWhen(row.last_used_at)}`
                          : ""}
                      </span>
                    </div>
                    <div className="share-dialog-row-actions">
                      <Button
                        type="button"
                        disabled={busy || !row.url}
                        onClick={() =>
                          void onCopy("link", row.token, "Link", row.url)
                        }
                      >
                        {copiedKey === copyKey("link", row.token)
                          ? "Copied"
                          : "Copy link"}
                      </Button>
                      {row.mcp_url ? (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void onCopy(
                              "mcp",
                              row.token,
                              "Agent URL",
                              row.mcp_url,
                            )
                          }
                        >
                          {copiedKey === copyKey("mcp", row.token)
                            ? "Copied"
                            : "Copy agent URL"}
                        </Button>
                      ) : null}
                      <Button
                        variant="danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void onRevoke(row.token)}
                      >
                        Stop sharing
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <section aria-labelledby={recordRoomsHeadingId}>
          <h3 className="share-dialog-heading" id={recordRoomsHeadingId}>
            Record rooms
          </h3>
          <div className="share-dialog-scroller-rooms">
            {recordRooms.length === 0 ? (
              <p className="share-dialog-empty">No live record rooms.</p>
            ) : (
              <ul className="share-dialog-list">
                {recordRooms.map((room) => (
                  <li key={room.sessionId} className="share-dialog-row">
                    {(room.guests.length === 0 ? [null] : room.guests).map(
                      (guest, index) => (
                        <div key={guest?.token ?? `guest-missing-${index}`}>
                          <div className="share-dialog-row-main">
                            <span className="share-dialog-token">
                              {guest ? "Guest link" : "Guest link (missing)"}
                            </span>
                            <span className="share-dialog-meta">
                              {guest?.token ?? room.sessionId}
                            </span>
                          </div>
                          <div className="share-dialog-row-actions">
                            <Button
                              type="button"
                              disabled={busy || !guest?.url}
                              onClick={() =>
                                void onCopy(
                                  "link",
                                  guest?.token ?? room.sessionId,
                                  "Guest link",
                                  guest?.url ?? null,
                                )
                              }
                            >
                              {copiedKey ===
                              copyKey("link", guest?.token ?? room.sessionId)
                                ? "Copied guest link"
                                : "Copy guest link"}
                            </Button>
                          </div>
                        </div>
                      ),
                    )}
                    {(room.producers.length === 0
                      ? [null]
                      : room.producers
                    ).map((producer, index) => (
                      <div key={producer?.token ?? `producer-missing-${index}`}>
                        <div className="share-dialog-row-main">
                          <span className="share-dialog-token">
                            Producer link
                          </span>
                          <span className="share-dialog-meta">
                            {producer?.token ?? "missing"}
                          </span>
                        </div>
                        <div className="share-dialog-row-actions">
                          <Button
                            type="button"
                            disabled={busy || !producer?.url}
                            onClick={() =>
                              void onCopy(
                                "link",
                                producer?.token ?? `${room.sessionId}-producer`,
                                "Producer link",
                                producer?.url ?? null,
                              )
                            }
                          >
                            {copiedKey ===
                            copyKey(
                              "link",
                              producer?.token ?? `${room.sessionId}-producer`,
                            )
                              ? "Copied producer link"
                              : "Copy producer link"}
                          </Button>
                          {index === 0 ? (
                            <>
                              <Button
                                type="button"
                                disabled={busy}
                                onClick={() => {
                                  setShareDialogOpen(false);
                                  void execute("record.openPanel");
                                }}
                              >
                                Open room panel
                              </Button>
                              <Button
                                variant="danger"
                                type="button"
                                disabled={busy}
                                onClick={() => void onEndRoom(room.sessionId)}
                              >
                                End room
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
        <div className="share-dialog-live" aria-live="polite">
          {error ? <InlineError message={error} /> : null}
          {status && !error ? (
            <p className="share-dialog-status">{status}</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
