import { randomUuid } from "../utils/randomUuid";
import { getTab, setTab } from "../utils/tabStorage";
export const MARKER_BODY = "Marker";
export const HOST_COMMENT_QUEUE_TOKEN = "host";
export const LIVE_COMMENT_QUEUE_MAX = 500;
export const LIVE_COMMENT_ID_PREFIX = "live-";

export type LiveComment = {
  id: string;
  take_index: number;
  recording_ms: number;
  pressed_wall_ms: number;
  author: string;
  body: string;
};

export function commentsQueueKey(token: string): string {
  return `record:${token}:comments`;
}

function newCommentId(): string {
  return `${LIVE_COMMENT_ID_PREFIX}${randomUuid()}`;
}

export function buildLiveComment(opts: {
  body: string;
  takeIndex: number;
  recordingMs: number;
  author: string;
  pressedWallMs?: number;
  id?: string;
}): LiveComment {
  const body = opts.body.trim() || MARKER_BODY;
  return {
    id: opts.id || newCommentId(),
    take_index: opts.takeIndex,
    recording_ms: Math.max(0, Math.round(opts.recordingMs)),
    pressed_wall_ms: opts.pressedWallMs ?? Date.now(),
    author: opts.author,
    body,
  };
}

function mergeById(rows: LiveComment[]): LiveComment[] {
  const byId = new Map<string, LiveComment>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function capQueue(rows: LiveComment[]): LiveComment[] {
  if (rows.length <= LIVE_COMMENT_QUEUE_MAX) {
    return rows;
  }
  return rows.slice(rows.length - LIVE_COMMENT_QUEUE_MAX);
}

export function loadCommentQueue(token: string): LiveComment[] {
  try {
    const raw = getTab(commentsQueueKey(token));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return mergeById(
      parsed.filter((row): row is LiveComment => {
        return (
          !!row &&
          typeof row === "object" &&
          typeof (row as LiveComment).id === "string" &&
          typeof (row as LiveComment).body === "string"
        );
      }),
    );
  } catch {
    return [];
  }
}

export function saveCommentQueue(token: string, rows: LiveComment[]): boolean {
  try {
    return setTab(
      commentsQueueKey(token),
      JSON.stringify(capQueue(mergeById(rows))),
    );
  } catch {
    return false;
  }
}

export function enqueueComment(token: string, comment: LiveComment): boolean {
  const latest = loadCommentQueue(token);
  const byId = new Map(latest.map((row) => [row.id, row]));
  byId.set(comment.id, comment);
  return saveCommentQueue(token, [...byId.values()]);
}

export function dequeueComment(token: string, id: string): boolean {
  return saveCommentQueue(
    token,
    loadCommentQueue(token).filter((row) => row.id !== id),
  );
}

export function retainUnackedComments(
  token: string,
  ackedIds: ReadonlySet<string>,
): LiveComment[] {
  const latest = loadCommentQueue(token);
  const remaining = latest.filter((row) => !ackedIds.has(row.id));
  if (remaining.length !== latest.length) {
    saveCommentQueue(token, remaining);
  }
  return remaining;
}

export function postLiveComment(
  send: (
    commandType: string,
    payload: Record<string, unknown>,
    commandId?: string,
  ) => boolean | void,
  token: string,
  opts: {
    body: string;
    takeIndex: number;
    recordingMs: number;
    author: string;
  },
): LiveComment | null {
  const comment = buildLiveComment(opts);
  const queued = enqueueComment(token, comment);
  const sent = send("Comment", comment);
  return queued || sent !== false ? comment : null;
}

export function liveTakeOpen(state: string | undefined): boolean {
  return state === "recording" || state === "paused";
}

export const NOTES_CLOSED_REASON = "Notes open while a take is running.";
