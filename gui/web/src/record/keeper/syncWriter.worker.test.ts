import { describe, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import {
  createOpfsSyncEngine,
  type SyncWriterScope,
  startSyncWriterWorker,
} from "./syncWriter.worker";
import type {
  SyncAccessHandleLike,
  SyncWriterOutMsg,
} from "./syncWriterProtocol";

function scope() {
  const out: SyncWriterOutMsg[] = [];
  const s: SyncWriterScope = {
    postMessage: (m) => {
      out.push(m);
    },
    onmessage: null,
  };
  return { s, out };
}

describe("startSyncWriterWorker", () => {
  it("announces readiness first", () => {
    const { s, out } = scope();
    startSyncWriterWorker(s, {
      supported: true,
      openHandle: vi.fn(),
      now: () => 0,
    });
    expect(out[0]).toEqual({ type: "ready", supported: true });
  });

  it("handles messages in order", async () => {
    const { s, out } = scope();
    const gate = deferred<SyncAccessHandleLike>();
    startSyncWriterWorker(s, {
      supported: true,
      openHandle: () => gate.promise,
      now: () => 0,
    });
    s.onmessage?.({
      data: { type: "open", id: 1, path: "a.wav" },
    } as MessageEvent);
    s.onmessage?.({
      data: { type: "write", id: 2, bytes: new ArrayBuffer(2), offset: 0 },
    } as MessageEvent);
    await Promise.resolve();
    expect(out).toHaveLength(1);
    gate.resolve({
      write: (b) => b.byteLength,
      flush: () => undefined,
      close: () => undefined,
    });
    await vi.waitFor(() => expect(out).toHaveLength(3));
    expect(out.slice(1)).toEqual([
      { type: "result", id: 1 },
      { type: "result", id: 2 },
    ]);
  });

  it("answers a request whose reply fails to post and keeps handling messages", async () => {
    const out: SyncWriterOutMsg[] = [];
    let calls = 0;
    const s: SyncWriterScope = {
      postMessage: (m) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("DataCloneError");
        }
        out.push(m);
      },
      onmessage: null,
    };
    startSyncWriterWorker(s, {
      supported: true,
      openHandle: async () => ({
        write: (b) => b.byteLength,
        flush: () => undefined,
        close: () => undefined,
      }),
      now: () => 0,
    });
    s.onmessage?.({
      data: { type: "open", id: 1, path: "a.wav" },
    } as MessageEvent);
    s.onmessage?.({
      data: { type: "write", id: 2, bytes: new ArrayBuffer(2), offset: 0 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(out).toContainEqual({ type: "result", id: 2 }),
    );
    expect(out).toContainEqual({
      type: "error",
      id: 1,
      name: "Error",
      message: "DataCloneError",
    });
  });

  it("keeps handling messages when the error reply also fails", async () => {
    const out: SyncWriterOutMsg[] = [];
    let calls = 0;
    const s: SyncWriterScope = {
      postMessage: (m) => {
        calls += 1;
        if (calls === 2 || calls === 3) {
          throw new Error("DataCloneError");
        }
        out.push(m);
      },
      onmessage: null,
    };
    startSyncWriterWorker(s, {
      supported: true,
      openHandle: async () => ({
        write: (b) => b.byteLength,
        flush: () => undefined,
        close: () => undefined,
      }),
      now: () => 0,
    });
    s.onmessage?.({
      data: { type: "open", id: 1, path: "a.wav" },
    } as MessageEvent);
    s.onmessage?.({
      data: { type: "write", id: 2, bytes: new ArrayBuffer(2), offset: 0 },
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(out).toContainEqual({ type: "result", id: 2 }),
    );
    expect(out.some((m) => m.type === "error")).toBe(false);
  });

  it("reports sync access handles unsupported under jsdom", () => {
    expect(createOpfsSyncEngine().supported).toBe(false);
  });
});
