import { describe, expect, it, vi } from "vitest";
import {
  createSyncWriterHandler,
  KEEPER_FLUSH_INTERVAL_MS,
  type SyncAccessHandleLike,
} from "./syncWriterProtocol";

function setup() {
  let now = 0;
  const handle = {
    write: vi.fn((b: Uint8Array) => b.byteLength),
    flush: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const openHandle = vi.fn(async () => handle as SyncAccessHandleLike);
  const handler = createSyncWriterHandler({
    supported: true,
    openHandle,
    now: () => now,
  });
  return {
    handle,
    openHandle,
    handler,
    setNow: (n: number) => {
      now = n;
    },
  };
}

const bytes = (n: number) => new Uint8Array(n).buffer;

describe("createSyncWriterHandler", () => {
  it("writes in place at the requested offset", async () => {
    const { handler, handle } = setup();
    await handler({ type: "open", id: 1, path: "a.wav" });
    const out = await handler({
      type: "write",
      id: 2,
      bytes: bytes(4),
      offset: 44,
    });
    expect(out).toEqual({ type: "result", id: 2 });
    expect(handle.write).toHaveBeenCalledWith(expect.any(Uint8Array), {
      at: 44,
    });
  });

  it("flushes at most once per interval", async () => {
    const { handler, handle, setNow } = setup();
    await handler({ type: "open", id: 1, path: "a.wav" });
    setNow(KEEPER_FLUSH_INTERVAL_MS - 1);
    await handler({ type: "write", id: 2, bytes: bytes(2), offset: 0 });
    expect(handle.flush).not.toHaveBeenCalled();
    setNow(KEEPER_FLUSH_INTERVAL_MS);
    await handler({ type: "write", id: 3, bytes: bytes(2), offset: 2 });
    expect(handle.flush).toHaveBeenCalledTimes(1);
    await handler({ type: "write", id: 4, bytes: bytes(2), offset: 4 });
    expect(handle.flush).toHaveBeenCalledTimes(1);
  });

  it("reports a short write", async () => {
    const { handler, handle } = setup();
    handle.write.mockReturnValue(1);
    await handler({ type: "open", id: 1, path: "a.wav" });
    const out = await handler({
      type: "write",
      id: 2,
      bytes: bytes(4),
      offset: 0,
    });
    expect(out).toMatchObject({ type: "error", id: 2 });
    expect(out.type === "error" && out.message).toMatch(/short write/);
  });

  it("rejects a write before open", async () => {
    const { handler } = setup();
    const out = await handler({
      type: "write",
      id: 1,
      bytes: bytes(1),
      offset: 0,
    });
    expect(out.type).toBe("error");
  });

  it("flushes then closes, and close is idempotent", async () => {
    const { handler, handle } = setup();
    await handler({ type: "open", id: 1, path: "a.wav" });
    expect(await handler({ type: "close", id: 2 })).toEqual({
      type: "result",
      id: 2,
    });
    expect(handle.flush).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await handler({ type: "close", id: 3 })).toEqual({
      type: "result",
      id: 3,
    });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("still closes when the final flush fails", async () => {
    const { handler, handle } = setup();
    handle.flush.mockRejectedValue(new Error("disk full"));
    await handler({ type: "open", id: 1, path: "a.wav" });
    const out = await handler({ type: "close", id: 2 });
    expect(out).toMatchObject({ type: "error", message: "disk full" });
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the DOMException name from a failed open", async () => {
    const { handler, openHandle } = setup();
    openHandle.mockRejectedValue(
      new DOMException("locked", "NoModificationAllowedError"),
    );
    const out = await handler({ type: "open", id: 1, path: "a.wav" });
    expect(out).toMatchObject({
      type: "error",
      name: "NoModificationAllowedError",
    });
  });

  it("rejects a second open", async () => {
    const { handler } = setup();
    await handler({ type: "open", id: 1, path: "a.wav" });
    const out = await handler({ type: "open", id: 2, path: "b.wav" });
    expect(out.type).toBe("error");
  });
});
