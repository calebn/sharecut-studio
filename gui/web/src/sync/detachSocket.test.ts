import { describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { detachSocket } from "./detachSocket";

describe("detachSocket", () => {
  it("clears every handler before closing, so the close fires nothing", () => {
    FakeWebSocket.reset({ autoOpen: false });
    const ws = new FakeWebSocket("ws://test");
    const onclose = vi.fn();
    ws.onopen = vi.fn();
    ws.onmessage = vi.fn();
    ws.onclose = onclose;
    ws.onerror = vi.fn();
    detachSocket(ws as unknown as WebSocket);
    expect(ws.closed).toBe(true);
    expect(onclose).not.toHaveBeenCalled();
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(ws.onerror).toBeNull();
  });
});
