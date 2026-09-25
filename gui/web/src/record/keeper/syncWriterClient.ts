import type { ByteStream } from "./store";
import {
  type SyncWriterInMsg,
  type SyncWriterOutMsg,
  SyncWriterUnavailableError,
} from "./syncWriterProtocol";

export const SYNC_WRITER_READY_TIMEOUT_MS = 2_000;

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
  readyTimeoutMs = SYNC_WRITER_READY_TIMEOUT_MS,
): SyncWriterClient {
  let unavailable = false;
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
      let settleReady: (ok: boolean) => void = () => undefined;
      const ready = new Promise<boolean>((resolve) => {
        settleReady = resolve;
      });
      const timer = setTimeout(() => settleReady(false), readyTimeoutMs);
      const onFailure = () => {
        if (!isReady) {
          settleReady(false);
          return;
        }
        const error = new Error(
          "The local recording writer stopped unexpectedly.",
        );
        for (const p of pending.values()) {
          p.reject(error);
        }
        pending.clear();
        worker.terminate();
      };
      worker.onerror = onFailure;
      worker.onmessageerror = onFailure;
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          isReady = true;
          settleReady(msg.supported);
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
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage(build(id), transfer);
        });

      const ok = await ready;
      clearTimeout(timer);
      if (!ok) {
        unavailable = true;
        worker.terminate();
        throw new SyncWriterUnavailableError();
      }
      try {
        await request((id) => ({ type: "open", id, path }));
      } catch (error) {
        worker.terminate();
        throw error;
      }
      let end = 0;
      let closed = false;
      return {
        async write(bytes: Uint8Array, offset?: number) {
          const at = offset ?? end;
          const buf = bytes.slice().buffer as ArrayBuffer;
          const done = request(
            (id) => ({ type: "write", id, bytes: buf, offset: at }),
            [buf],
          );
          end = Math.max(end, at + bytes.byteLength);
          await done;
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
