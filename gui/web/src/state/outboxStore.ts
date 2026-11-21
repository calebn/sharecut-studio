/** Rows live under `outbox:<token>`; each `id` is the server's repeat key, so resending a send that landed is harmless. */

import { idbGet, updateStoredList } from "./idbKv";

export type OutboxAnchor = {
  timeline_start: number;
  timeline_end: number | null;
  timeline_spans: { start: number; end: number }[] | null;
  track_ids: string[];
  edit_decision_id: string | null;
};

export type OutboxRow = {
  id: string;
  kind: "comment" | "reply";
  body: string;
  author: string;
  created_at: number;
  anchor?: OutboxAnchor;
  parent_comment_id?: string;
};

type ReturnedPost = OutboxRow & {
  reason: string;
  status: number | null;
};

const HEX_ID = /^[0-9a-f]{32}$/;
const LANDED_ID = /^g-.+-([0-9a-f]{32})$/;

export function waitingSlot(rowId: string): string {
  return `g-${rowId}`;
}

/** The id a comment keeps from kept to landed, so its card stays one element; the server id ends with the guest's key. */
export function slotOf(commentId: string): string {
  const landed = LANDED_ID.exec(commentId);
  return landed ? waitingSlot(landed[1]) : commentId;
}

export function serverIdOf(
  slot: string,
  comments: readonly { id: string }[],
): string | null {
  if (!HEX_ID.test(slot.slice(2)) || !slot.startsWith("g-")) return slot;
  return comments.find((c) => slotOf(c.id) === slot)?.id ?? null;
}

function outboxKey(token: string): string {
  return `outbox:${token}`;
}

function returnedKey(token: string): string {
  return `outbox-returned:${token}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAnchor(value: unknown): OutboxAnchor {
  if (
    !isRecord(value) ||
    typeof value.timeline_start !== "number" ||
    !Number.isFinite(value.timeline_start) ||
    (value.timeline_end !== null &&
      (typeof value.timeline_end !== "number" ||
        !Number.isFinite(value.timeline_end))) ||
    !Array.isArray(value.track_ids) ||
    !value.track_ids.every((id) => typeof id === "string") ||
    (value.edit_decision_id !== null &&
      typeof value.edit_decision_id !== "string")
  ) {
    throw new Error("Invalid saved comment anchor");
  }
  let spans: OutboxAnchor["timeline_spans"] = null;
  if (value.timeline_spans !== null) {
    if (!Array.isArray(value.timeline_spans)) {
      throw new Error("Invalid saved comment anchor");
    }
    spans = value.timeline_spans.map((span: unknown) => {
      if (
        !isRecord(span) ||
        typeof span.start !== "number" ||
        typeof span.end !== "number"
      ) {
        throw new Error("Invalid saved comment anchor");
      }
      return { start: span.start, end: span.end };
    });
  }
  return {
    timeline_start: value.timeline_start,
    timeline_end: value.timeline_end as number | null,
    timeline_spans: spans,
    track_ids: [...(value.track_ids as string[])],
    edit_decision_id: value.edit_decision_id as string | null,
  };
}

function parseOutboxRow(value: unknown): OutboxRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !HEX_ID.test(value.id) ||
    (value.kind !== "comment" && value.kind !== "reply") ||
    typeof value.body !== "string" ||
    typeof value.author !== "string" ||
    typeof value.created_at !== "number" ||
    !Number.isFinite(value.created_at)
  ) {
    throw new Error("Invalid saved comment");
  }
  if (value.kind === "comment") {
    return {
      id: value.id,
      kind: "comment",
      body: value.body,
      author: value.author,
      created_at: value.created_at,
      anchor: parseAnchor(value.anchor),
    };
  }
  if (
    typeof value.parent_comment_id !== "string" ||
    value.parent_comment_id.length === 0
  ) {
    throw new Error("Invalid saved reply");
  }
  return {
    id: value.id,
    kind: "reply",
    body: value.body,
    author: value.author,
    created_at: value.created_at,
    parent_comment_id: value.parent_comment_id,
  };
}

function parseOutboxList(value: unknown): OutboxRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid saved comment list");
  return Array.from(value, parseOutboxRow);
}

function parseReturnedRow(value: unknown): ReturnedPost {
  const row = parseOutboxRow(value);
  const rest = value as Record<string, unknown>;
  if (typeof rest.reason !== "string") throw new Error("Invalid saved refusal");
  const status = rest.status;
  if (status !== null && typeof status !== "number") {
    throw new Error("Invalid saved refusal");
  }
  return { ...row, reason: rest.reason, status };
}

function parseReturnedList(value: unknown): ReturnedPost[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid saved refusal list");
  return Array.from(value, parseReturnedRow);
}

export async function loadOutbox(token: string): Promise<OutboxRow[]> {
  return parseOutboxList(await idbGet<unknown>(outboxKey(token)));
}

export async function loadReturnedPosts(
  token: string,
): Promise<ReturnedPost[]> {
  return parseReturnedList(await idbGet<unknown>(returnedKey(token)));
}

/** True once the row is stored; false when this browser keeps nothing, so the caller must not say it is kept. */
export async function appendOutbox(
  token: string,
  row: OutboxRow,
): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const admitted = parseOutboxRow(row);
  await updateStoredList<OutboxRow, void>(
    outboxKey(token),
    parseOutboxList,
    (rows) => ({
      items: rows.some((item) => item.id === admitted.id)
        ? rows
        : [...rows, admitted],
      result: undefined,
    }),
  );
  await refreshOutboxView(token);
  return true;
}

export async function restoreOutbox(
  token: string,
  row: OutboxRow,
): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const admitted = parseOutboxRow(row);
  await updateStoredList<OutboxRow, void>(
    outboxKey(token),
    parseOutboxList,
    (rows) => {
      if (rows.some((item) => item.id === admitted.id)) {
        return { items: rows, result: undefined };
      }
      const at = rows.findIndex(
        (item) => item.created_at > admitted.created_at,
      );
      const items = [...rows];
      items.splice(at < 0 ? rows.length : at, 0, admitted);
      return { items, result: undefined };
    },
  );
  await refreshOutboxView(token);
  return true;
}

export async function removeOutbox(
  token: string,
  id: string,
): Promise<OutboxRow | null> {
  if (typeof indexedDB === "undefined") return null;
  const removed = await updateStoredList<OutboxRow, OutboxRow | null>(
    outboxKey(token),
    parseOutboxList,
    (rows) => ({
      items: rows.filter((row) => row.id !== id),
      result: rows.find((row) => row.id === id) ?? null,
    }),
  );
  await refreshOutboxView(token);
  return removed;
}

/** Written to the returned list first, so a crash between the two writes shows the row twice, never loses its text. */
export async function returnOutboxRow(
  token: string,
  id: string,
  reason: string,
  status: number | null,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const rows = await loadOutbox(token);
  const row = rows.find((item) => item.id === id);
  if (!row) return;
  await updateStoredList<ReturnedPost, void>(
    returnedKey(token),
    parseReturnedList,
    (returned) => ({
      items: [
        ...returned.filter((item) => item.id !== id),
        { ...row, reason, status },
      ],
      result: undefined,
    }),
  );
  await removeOutbox(token, id);
}

export async function removeReturned(
  token: string,
  id: string,
): Promise<ReturnedPost | null> {
  if (typeof indexedDB === "undefined") return null;
  const removed = await updateStoredList<ReturnedPost, ReturnedPost | null>(
    returnedKey(token),
    parseReturnedList,
    (returned) => ({
      items: returned.filter((item) => item.id !== id),
      result: returned.find((item) => item.id === id) ?? null,
    }),
  );
  await refreshOutboxView(token);
  return removed;
}

export type OutboxView = {
  rows: readonly OutboxRow[];
  returned: readonly ReturnedPost[];
  sending: ReadonlySet<string>;
  loaded: boolean;
};

const EMPTY: OutboxView = {
  rows: [],
  returned: [],
  sending: new Set(),
  loaded: false,
};

const OUTBOX_POLL_MS = 2_000;

type Watched = {
  view: OutboxView;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval>;
  generation: number;
};

const watched = new Map<string, Watched>();
const sendingByToken = new Map<string, Set<string>>();

function publish(token: string, patch: Partial<OutboxView>): void {
  const entry = watched.get(token);
  if (!entry) return;
  const next = { ...entry.view, ...patch };
  const same =
    next.loaded === entry.view.loaded &&
    next.sending === entry.view.sending &&
    sameList(next.rows, entry.view.rows) &&
    sameList(next.returned, entry.view.returned);
  if (same) return;
  entry.view = next;
  for (const listener of [...entry.listeners]) listener();
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

async function refreshOutboxView(token: string): Promise<void> {
  const entry = watched.get(token);
  if (!entry) return;
  const reading = ++entry.generation;
  try {
    const [rows, returned] = await Promise.all([
      loadOutbox(token),
      loadReturnedPosts(token),
    ]);
    if (reading !== entry.generation) return;
    publish(token, { rows, returned, loaded: true });
  } catch {
    // The attention poll reports an unreadable store; the view keeps what it had.
  }
}

export function setOutboxSending(
  token: string,
  id: string,
  sending: boolean,
): void {
  const ids = new Set(sendingByToken.get(token) ?? []);
  if (sending) ids.add(id);
  else ids.delete(id);
  if (ids.size > 0) sendingByToken.set(token, ids);
  else sendingByToken.delete(token);
  publish(token, { sending: ids });
}

export function subscribeOutbox(
  token: string,
  listener: () => void,
): () => void {
  let entry = watched.get(token);
  if (!entry) {
    const created: Watched = {
      view: { ...EMPTY, sending: sendingByToken.get(token) ?? EMPTY.sending },
      listeners: new Set(),
      timer: setInterval(() => void refreshOutboxView(token), OUTBOX_POLL_MS),
      generation: 0,
    };
    watched.set(token, created);
    entry = created;
    void refreshOutboxView(token);
  }
  entry.listeners.add(listener);
  return () => {
    const current = watched.get(token);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      clearInterval(current.timer);
      watched.delete(token);
    }
  };
}

export function outboxViewOf(token: string | null): OutboxView {
  return (token && watched.get(token)?.view) || EMPTY;
}
