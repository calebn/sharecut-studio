import { bindWsSender, type WsSender } from "../session/wsSend";
import { isTerminalWsClose } from "../utils/wsClose";
import { detachSocket } from "./detachSocket";
import { hostReconnectDelay } from "./hostReconnect";
import { enqueueInbound } from "./inboundQueue";

export type PlaneFrame = { plane?: string; type?: string };

export type PlaneSocketContext = {
  send: WsSender;
  /** False once this socket is retired or the owner stopped; late work must return early. */
  isCurrent: () => boolean;
  /** The connection is established: the next drop reconnects from the shortest delay. */
  markHealthy: () => void;
  /** Close this socket now; the reconnect policy applies as for any other close. */
  close: (code?: number, reason?: string) => void;
  /** Reconnect after `ms` once this socket closes, instead of the jittered backoff. */
  retryIn: (ms: number) => void;
};

export type PlaneHandler<M extends PlaneFrame> = {
  handle: (msg: M, ctx: PlaneSocketContext) => void;
  /** A newer job with the same key replaces an older still-queued one. */
  coalesceKey?: (msg: M) => string | undefined;
  /** Frames it returns false for are dropped at receipt, before queueing. */
  accepts?: (msg: M) => boolean;
  /** Run unqueued, at receipt. Default: through the per-frame inbound queue. */
  immediate?: boolean;
};

export type PlaneSocketOptions<M extends PlaneFrame> = {
  /** Read on every connection attempt, so a rotated session token is picked up. */
  url: string | (() => string);
  /** Extra liveness test (the document scope): a socket stops counting as current when it returns false. */
  isActive?: () => boolean;
  /** Runs before every connection attempt; returning false stops the socket for good. */
  prepare?: () => Promise<boolean | undefined> | boolean | undefined;
  onOpen: (ctx: PlaneSocketContext) => void;
  /** Synchronous, at receipt and before queueing: clock samples and id handoffs. */
  onReceive?: (msg: M, ctx: PlaneSocketContext) => void;
  /** Per-plane handlers, picked by `msg.plane`. */
  planes?: Partial<Record<string, PlaneHandler<M>>>;
  /** Frames whose plane has no handler. */
  fallback?: PlaneHandler<M>;
  onMalformed?: () => void;
  onClose: (event: CloseEvent, ctx: PlaneSocketContext) => void;
  /** Default: reconnect unless the grant was revoked (`isTerminalWsClose`). */
  shouldReconnect?: (event: CloseEvent) => boolean;
};

export type PlaneSocket = { stop: () => void };

/**
 * The one realtime WebSocket client: connect, one jittered reconnect policy,
 * plane demux and inbound ordering. The host, guest and record hooks pass their
 * URL and per-plane handlers and keep their own state.
 */
export function openPlaneSocket<M extends PlaneFrame>(
  options: PlaneSocketOptions<M>,
): PlaneSocket {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let attempt = 0;
  let nextDelay: number | null = null;

  const connect = () => {
    if (stopped) return;
    const prepared = options.prepare?.();
    if (prepared instanceof Promise) {
      void prepared.then((ok) => {
        if (ok !== false && !stopped) open();
      });
    } else if (prepared !== false) {
      open();
    }
  };

  const open = () => {
    const thisSocket = new WebSocket(
      typeof options.url === "function" ? options.url() : options.url,
    );
    socket = thisSocket;
    let retired = false;
    const isCurrent = () =>
      !stopped &&
      !retired &&
      socket === thisSocket &&
      (options.isActive?.() ?? true);
    const ctx: PlaneSocketContext = {
      send: bindWsSender(thisSocket),
      isCurrent,
      markHealthy: () => {
        attempt = 0;
      },
      close: (code, reason) => thisSocket.close(code, reason),
      retryIn: (ms) => {
        nextDelay = ms;
      },
    };
    thisSocket.onopen = () => {
      if (isCurrent()) options.onOpen(ctx);
    };
    thisSocket.onmessage = (ev) => {
      if (!isCurrent()) return;
      let msg: M;
      try {
        msg = JSON.parse(String(ev.data)) as M;
        if (!msg || typeof msg !== "object") return;
      } catch {
        options.onMalformed?.();
        return;
      }
      options.onReceive?.(msg, ctx);
      const handler =
        (msg.plane !== undefined && options.planes
          ? Object.hasOwn(options.planes, msg.plane)
            ? options.planes[msg.plane]
            : undefined
          : undefined) ?? options.fallback;
      if (!handler || handler.accepts?.(msg) === false) return;
      const run = () => {
        if (isCurrent()) handler.handle(msg, ctx);
      };
      if (handler.immediate) {
        run();
      } else {
        enqueueInbound(run, { coalesceKey: handler.coalesceKey?.(msg) });
      }
    };
    thisSocket.onclose = (event) => {
      if (!isCurrent()) return;
      retired = true;
      options.onClose(event, ctx);
      const reconnect = options.shouldReconnect
        ? options.shouldReconnect(event)
        : !isTerminalWsClose(event.code);
      if (!reconnect || stopped) return;
      const delay = nextDelay ?? hostReconnectDelay(attempt++);
      nextDelay = null;
      retryTimer = window.setTimeout(connect, delay);
    };
    thisSocket.onerror = () => {
      if (socket === thisSocket) thisSocket.close();
    };
  };
  connect();

  return {
    stop: () => {
      stopped = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (socket) detachSocket(socket);
    },
  };
}
