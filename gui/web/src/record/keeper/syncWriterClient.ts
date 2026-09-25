import type { ByteStream } from "./store";
import {
  type SyncWriterInMsg,
  type SyncWriterOutMsg,
  SyncWriterUnavailableError,
} from "./syncWriterProtocol";

export const SYNC_WRITER_READY_TIMEOUT_MS = 2_000;
/** Bounds the worker's createSyncAccessHandle(); on timeout the worker is terminated (so it cannot take the exclusive handle late) and the segment falls back to createWritable(). */
export const SYNC_WRITER_OPEN_TIMEOUT_MS = 5_000;
/** Consecutive slow or crashed worker starts before in-place writes stay off for this tab. */
export const SYNC_WRITER_MAX_START_FAILURES = 2;

export type SyncWriterClientOptions = {
  readyTimeoutMs?: number;
  openTimeoutMs?: number;
};

type ReadyState = "supported" | "unsupported" | "failed";

export type SyncWriterWorker = {
  postMessage(msg: SyncWriterInMsg, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<SyncWriterOutMsg>) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
};

export type SyncWriterClient = { open(path: string): Promise<ByteStream> };

type Pending = { resolve: () => void; reject: (error: Error) => void };

export function createSyncWriterClient(
  spawn: () => SyncWriterWorker | null,
  {
    readyTimeoutMs = SYNC_WRITER_READY_TIMEOUT_MS,
    openTimeoutMs = SYNC_WRITER_OPEN_TIMEOUT_MS,
  }: SyncWriterClientOptions = {},
): SyncWriterClient {
  let unavailable = false;
  let startFailures = 0;
  /** Count a slow or crashed start; enough in a row turn in-place writes off for the tab. */
  const noteStartFailure = () => {
    startFailures += 1;
    if (startFailures >= SYNC_WRITER_MAX_START_FAILURES) {
      unavailable = true;
    }
  };
  return {
    async open(path: string): Promise<ByteStream> {
      if (unavailable) {
        throw new SyncWriterUnavailableError();
      }
      let spawned: SyncWriterWorker | null;
      try {
        spawned = spawn();
      } catch {
        spawned = null;
      }
      if (!spawned) {
        unavailable = true;
        throw new SyncWriterUnavailableError();
      }
      const worker = spawned;
      const pending = new Map<number, Pending>();
      let nextId = 1;
      let isReady = false;
      /** Set once the worker is gone; every later request rejects with it at once. */
      let failure: Error | null = null;
      let settleReady: (state: ReadyState) => void = () => undefined;
      const ready = new Promise<ReadyState>((resolve) => {
        settleReady = resolve;
      });
      const timer = setTimeout(() => settleReady("failed"), readyTimeoutMs);
      /** Terminate the worker (releasing its sync access handle) and reject everything outstanding. */
      const fail = (error: Error) => {
        failure ??= error;
        for (const p of pending.values()) {
          p.reject(failure);
        }
        pending.clear();
        worker.terminate();
      };
      const onFailure = () => {
        if (!isReady) {
          settleReady("failed");
          return;
        }
        fail(new Error("The local recording writer stopped unexpectedly."));
      };
      worker.onerror = onFailure;
      worker.onmessageerror = onFailure;
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          isReady = true;
          settleReady(msg.supported ? "supported" : "unsupported");
          return;
        }
        const p = pending.get(msg.id);
        if (!p) {
          return;
        }
        pending.delete(msg.id);
        if (msg.type === "error") {
          p.reject(Object.assign(new Error(msg.message), { name: msg.name }));
        } else {
          p.resolve();
        }
      };
      const request = (
        build: (id: number) => SyncWriterInMsg,
        transfer?: Transferable[],
      ) =>
        new Promise<void>((resolve, reject) => {
          if (failure) {
            reject(failure);
            return;
          }
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage(build(id), transfer);
        });

      const state = await ready;
      clearTimeout(timer);
      if (state !== "supported") {
        // Only an explicit "unsupported" latches at once; a slow or crashed
        // start falls back for this segment and counts toward the latch.
        if (state === "unsupported") {
          unavailable = true;
        } else {
          noteStartFailure();
        }
        worker.terminate();
        throw new SyncWriterUnavailableError();
      }
      const openTimeout = new Error(
        `keeper writer open timed out after ${openTimeoutMs}ms`,
      );
      const openTimer = setTimeout(() => fail(openTimeout), openTimeoutMs);
      try {
        await request((id) => ({ type: "open", id, path }));
      } catch (error) {
        worker.terminate();
        if (error === openTimeout) {
          // A hung createSyncAccessHandle() is a slow start: the worker is
          // gone, so fall back to createWritable() for this segment.
          noteStartFailure();
          throw new SyncWriterUnavailableError({ cause: error });
        }
        throw error;
      } finally {
        clearTimeout(openTimer);
      }
      startFailures = 0;
      let end = 0;
      let closed = false;
      /** First write failure; later writes reject so no offset-less write leaves a hole. */
      let writeError: Error | null = null;
      return {
        async write(bytes: Uint8Array, offset?: number) {
          if (writeError) {
            throw writeError;
          }
          const at = offset ?? end;
          const buf = bytes.slice().buffer as ArrayBuffer;
          const done = request(
            (id) => ({ type: "write", id, bytes: buf, offset: at }),
            [buf],
          );
          end = Math.max(end, at + bytes.byteLength);
          try {
            await done;
          } catch (error) {
            writeError ??= error as Error;
            throw error;
          }
        },
        async close() {
          if (closed) {
            return;
          }
          closed = true;
          try {
            await request((id) => ({ type: "close", id }));
          } finally {
            worker.terminate();
          }
        },
        abort() {
          fail(new Error("The local recording writer was aborted."));
        },
      };
    },
  };
}

export function spawnKeeperSyncWorker(): SyncWriterWorker | null {
  if (typeof Worker === "undefined") {
    return null;
  }
  return new Worker(new URL("./syncWriter.worker.ts", import.meta.url), {
    type: "module",
    name: "sharecut-keeper-writer",
  }) as unknown as SyncWriterWorker;
}

let shared: SyncWriterClient | null = null;

export function sharedKeeperSyncWriter(): SyncWriterClient {
  shared ??= createSyncWriterClient(spawnKeeperSyncWorker);
  return shared;
}
