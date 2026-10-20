import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { openPlaneSocket } from "./planeSocket";

type Frame = { plane?: string; type?: string; n?: number };

const open = (
  overrides: Partial<Parameters<typeof openPlaneSocket<Frame>>[0]> = {},
) =>
  openPlaneSocket<Frame>({
    url: "ws://test",
    onOpen: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  });

describe("openPlaneSocket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    FakeWebSocket.reset({ autoOpen: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("routes a frame to its plane handler and falls back otherwise", () => {
    const doc = vi.fn();
    const rest = vi.fn();
    open({ planes: { document: { handle: doc } }, fallback: { handle: rest } });
    const ws = FakeWebSocket.instances[0];
    ws.emit({ plane: "document", type: "A" });
    ws.emit({ plane: "other", type: "B" });
    expect(doc).toHaveBeenCalledTimes(1);
    expect(rest).toHaveBeenCalledTimes(1);
  });

  it("drops frames a handler does not accept before queueing", () => {
    const handle = vi.fn();
    open({ fallback: { handle, accepts: (m) => m.type === "ok" } });
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: "no" });
    ws.emit({ type: "ok" });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("reports malformed frames and keeps going", () => {
    const onMalformed = vi.fn();
    const handle = vi.fn();
    open({ onMalformed, fallback: { handle } });
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: "{nope" });
    ws.emit({ type: "ok" });
    expect(onMalformed).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("runs immediate handlers at receipt, unqueued", () => {
    const handle = vi.fn();
    open({ fallback: { handle, immediate: true } });
    FakeWebSocket.instances[0].deliver({ type: "x" });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("reconnects with a jittered delay that restarts after markHealthy", () => {
    let healthy: (() => void) | undefined;
    open({ onOpen: (ctx) => (healthy = ctx.markHealthy) });
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(1006);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].close(1006);
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(600);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.instances[2].open();
    healthy?.();
    FakeWebSocket.instances[2].close(1006);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("does not reconnect after a revoked grant", () => {
    open();
    FakeWebSocket.instances[0].close(4403);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("retryIn overrides the backoff once", () => {
    open({ onOpen: (ctx) => ctx.retryIn(250) });
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(1006);
    vi.advanceTimersByTime(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("stop silences the socket and cancels a pending reconnect", () => {
    const onClose = vi.fn();
    const sock = open({ onClose });
    FakeWebSocket.instances[0].close(1006);
    expect(onClose).toHaveBeenCalledTimes(1);
    sock.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores plane names that are only inherited object keys", () => {
    const handle = vi.fn();
    open({ fallback: { handle } });
    FakeWebSocket.instances[0].emit({ plane: "constructor", type: "x" });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("reads a function url on every reconnect", () => {
    let name = "a";
    open({ url: () => `ws://test?name=${name}` });
    FakeWebSocket.instances[0].close(1006);
    name = "b";
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances[1].url).toBe("ws://test?name=b");
  });

  it("drops frames once isActive turns false", () => {
    let active = true;
    const handle = vi.fn();
    open({ isActive: () => active, fallback: { handle } });
    active = false;
    FakeWebSocket.instances[0].emit({ type: "x" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("stops for good when prepare returns false", () => {
    open({ prepare: () => false });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("realtime socket governance", () => {
  it("opens WebSockets only in planeSocket.ts", () => {
    const root = join(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          if (readFileSync(path, "utf8").includes("new WebSocket(")) {
            offenders.push(path.slice(root.length + 1));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual(["sync/planeSocket.ts"]);
  });
});
