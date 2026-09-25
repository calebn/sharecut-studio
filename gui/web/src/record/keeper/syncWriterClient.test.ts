import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSyncWriterClient,
  SYNC_WRITER_READY_TIMEOUT_MS,
  type SyncWriterWorker,
} from "./syncWriterClient";
import {
  type SyncWriterInMsg,
  type SyncWriterOutMsg,
  SyncWriterUnavailableError,
} from "./syncWriterProtocol";

type Posted = { msg: SyncWriterInMsg; transfer?: Transferable[] };

function fakeWorker() {
  const posted: Posted[] = [];
  const terminate = vi.fn<() => void>();
  const worker: SyncWriterWorker & { emit(m: SyncWriterOutMsg): void } = {
    postMessage: (msg, transfer) => {
      posted.push({ msg, transfer });
    },
    terminate,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    emit(m) {
      worker.onmessage?.({ data: m } as MessageEvent<SyncWriterOutMsg>);
    },
  };
  return { worker, posted };
}

const tick = () => vi.advanceTimersByTimeAsync(0);

async function openReady() {
  const f = fakeWorker();
  const client = createSyncWriterClient(() => f.worker);
  const p = client.open("a.wav");
  f.worker.emit({ type: "ready", supported: true });
  await tick();
  f.worker.emit({ type: "result", id: 1 });
  return { ...f, client, stream: await p };
}

afterEach(() => vi.useRealTimers());

describe("createSyncWriterClient", () => {
  it("waits for ready, posts open and resolves a stream", async () => {
    vi.useFakeTimers();
    const { posted, stream } = await openReady();
    expect(posted[0].msg).toEqual({ type: "open", id: 1, path: "a.wav" });
    expect(stream).toBeDefined();
  });

  it("writes a copy at explicit and appended offsets", async () => {
    vi.useFakeTimers();
    const { worker, posted, stream } = await openReady();
    const data = new Uint8Array([1, 2, 3, 4]);
    const w1 = stream.write(data, 44);
    worker.emit({ type: "result", id: 2 });
    await w1;
    expect(Array.from(data)).toEqual([1, 2, 3, 4]);
    const first = posted[1];
    expect(first.msg).toMatchObject({ type: "write", offset: 44 });
    expect(first.transfer).toEqual([
      (first.msg as { bytes: ArrayBuffer }).bytes,
    ]);
    const w2 = stream.write(new Uint8Array(2));
    worker.emit({ type: "result", id: 3 });
    await w2;
    expect(posted[2].msg).toMatchObject({ type: "write", offset: 48 });
  });

  it("closes once and terminates", async () => {
    vi.useFakeTimers();
    const { worker, posted, stream } = await openReady();
    const c = stream.close();
    worker.emit({ type: "result", id: 2 });
    await c;
    expect(posted[1].msg.type).toBe("close");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await stream.close();
    expect(posted).toHaveLength(2);
  });

  it("marks unsupported and does not respawn", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const spawn = vi.fn(() => f.worker);
    const client = createSyncWriterClient(spawn);
    const assertion = expect(client.open("a.wav")).rejects.toBeInstanceOf(
      SyncWriterUnavailableError,
    );
    f.worker.emit({ type: "ready", supported: false });
    await assertion;
    await expect(client.open("b.wav")).rejects.toBeInstanceOf(
      SyncWriterUnavailableError,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when spawn returns null or throws", async () => {
    await expect(
      createSyncWriterClient(() => null).open("a"),
    ).rejects.toBeInstanceOf(SyncWriterUnavailableError);
    await expect(
      createSyncWriterClient(() => {
        throw new Error("csp");
      }).open("a"),
    ).rejects.toBeInstanceOf(SyncWriterUnavailableError);
  });

  it("times out waiting for ready", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const assertion = expect(
      createSyncWriterClient(() => f.worker).open("a"),
    ).rejects.toBeInstanceOf(SyncWriterUnavailableError);
    await vi.advanceTimersByTimeAsync(SYNC_WRITER_READY_TIMEOUT_MS);
    await assertion;
    expect(f.worker.terminate).toHaveBeenCalled();
  });

  it("treats an error before ready as unavailable", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const assertion = expect(
      createSyncWriterClient(() => f.worker).open("a"),
    ).rejects.toBeInstanceOf(SyncWriterUnavailableError);
    f.worker.onerror?.(new Event("error"));
    await assertion;
  });

  it("fails pending writes when the worker dies after ready", async () => {
    vi.useFakeTimers();
    const { worker, stream } = await openReady();
    const assertion = expect(stream.write(new Uint8Array(2))).rejects.toThrow(
      "stopped unexpectedly",
    );
    worker.onerror?.(new Event("error"));
    await assertion;
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("surfaces an open error without marking the client unavailable", async () => {
    vi.useFakeTimers();
    const f = fakeWorker();
    const g = fakeWorker();
    const spawn = vi
      .fn()
      .mockReturnValueOnce(f.worker)
      .mockReturnValue(g.worker);
    const client = createSyncWriterClient(spawn);
    const assertion = expect(client.open("a")).rejects.toMatchObject({
      name: "NoModificationAllowedError",
    });
    f.worker.emit({ type: "ready", supported: true });
    await tick();
    f.worker.emit({
      type: "error",
      id: 1,
      name: "NoModificationAllowedError",
      message: "locked",
    });
    await assertion;
    expect(f.worker.terminate).toHaveBeenCalled();
    void client.open("b").catch(() => undefined);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
