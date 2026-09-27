import { useId } from "react";
import type { HostShareRow, ShareRole } from "../types/shares";
import { Button, Dialog, EmptyState, Field, InlineError } from "../ui";
import {
  type ShareCopiedKey,
  type ShareCopyKind,
  shareCopyKey,
} from "./shareCopyKey";

const ROLES: { id: ShareRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "editor", label: "Editor" },
];

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

function groupRecordRooms(rows: readonly HostShareRow[]): RecordRoomGroup[] {
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

export type ShareDialogViewProps = {
  open: boolean;
  onClose: () => void;
  role: ShareRole;
  onRoleChange: (role: ShareRole) => void;
  withMcp: boolean;
  onWithMcpChange: (on: boolean) => void;
  /** Every host share row; the view shows usable rows only, split into review links and record rooms. */
  rows: readonly HostShareRow[];
  busy: boolean;
  error: string | null;
  status: string | null;
  copiedKey: ShareCopiedKey | null;
  onCreate: () => void;
  onCreateRecord: () => void;
  onCopy: (
    kind: ShareCopyKind,
    token: string,
    label: string,
    text: string | null,
  ) => void;
  onRevoke: (token: string) => void;
  onEndRoom: (sessionId: string) => void;
  onOpenRoomPanel: () => void;
};

/**
 * Production Share dialog paint. Listing, minting and revoking links, the
 * clipboard write, the copied-flash timer, `window.confirm` and the
 * record-panel handoff all stay with the `ShareDialog` adapter.
 */
export function ShareDialogView(props: ShareDialogViewProps) {
  const {
    open,
    onClose,
    role,
    onRoleChange,
    withMcp,
    onWithMcpChange,
    rows,
    busy,
    error,
    status,
    copiedKey,
    onCreate,
    onCreateRecord,
    onCopy,
    onRevoke,
    onEndRoom,
    onOpenRoomPanel,
  } = props;
  const roleId = useId();
  const mcpId = useId();
  const recordHeadingId = useId();
  const reviewLinksHeadingId = useId();
  const recordRoomsHeadingId = useId();

  const live = rows.filter((row) => row.usable);
  const reviewLive = live.filter((row) => row.kind !== "record");
  const recordRooms = groupRecordRooms(
    live.filter((row) => row.kind === "record"),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
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
            onChange={(e) => onRoleChange(e.target.value as ShareRole)}
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
            onChange={(e) => onWithMcpChange(e.target.checked)}
          />
          Allow agent (MCP)
        </label>
        <div className="share-dialog-actions">
          <Button
            variant="primary"
            type="button"
            disabled={busy}
            onClick={onCreate}
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
            <Button type="button" disabled={busy} onClick={onCreateRecord}>
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
              <EmptyState>No live review links.</EmptyState>
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
                          onCopy("link", row.token, "Link", row.url)
                        }
                      >
                        {copiedKey === shareCopyKey("link", row.token)
                          ? "Copied"
                          : "Copy link"}
                      </Button>
                      {row.mcp_url ? (
                        <Button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            onCopy("mcp", row.token, "Agent URL", row.mcp_url)
                          }
                        >
                          {copiedKey === shareCopyKey("mcp", row.token)
                            ? "Copied"
                            : "Copy agent URL"}
                        </Button>
                      ) : null}
                      <Button
                        variant="danger"
                        type="button"
                        disabled={busy}
                        onClick={() => onRevoke(row.token)}
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
              <EmptyState>No live record rooms.</EmptyState>
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
                                onCopy(
                                  "link",
                                  guest?.token ?? room.sessionId,
                                  "Guest link",
                                  guest?.url ?? null,
                                )
                              }
                            >
                              {copiedKey ===
                              shareCopyKey(
                                "link",
                                guest?.token ?? room.sessionId,
                              )
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
                              onCopy(
                                "link",
                                producer?.token ?? `${room.sessionId}-producer`,
                                "Producer link",
                                producer?.url ?? null,
                              )
                            }
                          >
                            {copiedKey ===
                            shareCopyKey(
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
                                onClick={onOpenRoomPanel}
                              >
                                Open room panel
                              </Button>
                              <Button
                                variant="danger"
                                type="button"
                                disabled={busy}
                                onClick={() => onEndRoom(room.sessionId)}
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
