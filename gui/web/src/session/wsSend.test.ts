import { describe, expect, it, vi } from "vitest";
import { bindWsSender } from "./wsSend";

describe("bindWsSender", () => {
  it("sends JSON only while the socket is open", () => {
    const send = vi.fn();
    const open = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;
    bindWsSender(open)({ type: "Presence" });
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "Presence" }));
    bindWsSender({
      readyState: WebSocket.CONNECTING,
      send,
    } as unknown as WebSocket)({ type: "Presence" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
