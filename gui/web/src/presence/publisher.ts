import type { PresenceMeta } from "../types/session";

export type PresenceSend = (frame: Record<string, unknown>) => void;

type ThrottleOpts = {
  cursorMs?: number;
  transportMs?: number;
  viewportMs?: number;
  uiMs?: number;
};

type SendCb = (meta: Partial<PresenceMeta>) => void;

export function createPresenceThrottle(opts: ThrottleOpts = {}) {
  const cursorMs = opts.cursorMs ?? 100;
  const transportMs = opts.transportMs ?? 200;
  const viewportMs = opts.viewportMs ?? 100;
  const uiMs = opts.uiMs ?? 100;
  let pending: Partial<PresenceMeta> = {};
  let lastCursor = Number.NEGATIVE_INFINITY;
  let lastTransport = Number.NEGATIVE_INFINITY;
  let lastViewport = Number.NEGATIVE_INFINITY;
  let lastUi = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let send: SendCb | null = null;
  let lastPlaying: boolean | undefined;
  let lastFollowing: string | null | undefined;
  let lastSelectionJson = "";
  let lastUiEdgeJson = "";

  const emit = (partial: Partial<PresenceMeta>) => {
    send?.(partial);
  };

  const flush = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    const next = pending;
    pending = {};
    if (Object.keys(next).length > 0) {
      emit(next);
    }
  };

  const schedule = (delay: number) => {
    if (timer != null) {
      return;
    }
    timer = setTimeout(flush, delay);
  };

  return {
    onSend(cb: SendCb) {
      send = cb;
    },
    push(partial: Partial<PresenceMeta>) {
      const now = Date.now();
      const edge =
        ("cursor" in partial && partial.cursor === null) ||
        ("following" in partial && partial.following !== lastFollowing) ||
        ("selection" in partial &&
          JSON.stringify(partial.selection) !== lastSelectionJson) ||
        ("ui" in partial &&
          JSON.stringify([
            partial.ui?.tab,
            partial.ui?.mobile_mode,
            partial.ui?.audition,
          ]) !== lastUiEdgeJson) ||
        ("transport" in partial &&
          partial.transport != null &&
          partial.transport.playing !== lastPlaying);
      pending = { ...pending, ...partial };
      if ("transport" in partial && partial.transport) {
        lastPlaying = partial.transport.playing;
      }
      if ("following" in partial) {
        lastFollowing = partial.following ?? null;
      }
      if ("selection" in partial) {
        lastSelectionJson = JSON.stringify(partial.selection);
      }
      if ("ui" in partial) {
        lastUiEdgeJson = JSON.stringify([
          partial.ui?.tab,
          partial.ui?.mobile_mode,
          partial.ui?.audition,
        ]);
        lastUi = now;
      }
      if (edge) {
        flush();
        return;
      }
      let delay = 100;
      if ("cursor" in partial) {
        delay = Math.max(0, cursorMs - (now - lastCursor));
        lastCursor = now;
      } else if ("transport" in partial) {
        delay = Math.max(0, transportMs - (now - lastTransport));
        lastTransport = now;
      } else if ("viewport" in partial) {
        delay = Math.max(0, viewportMs - (now - lastViewport));
        lastViewport = now;
      } else if ("ui" in partial) {
        delay = Math.max(0, uiMs - (now - lastUi));
        lastUi = now;
      }
      if (delay <= 0) {
        flush();
        return;
      }
      schedule(delay);
    },
    flush,
    heartbeat() {
      emit({ ...pending });
      pending = {};
    },
    dispose() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      send = null;
      pending = {};
    },
  };
}
