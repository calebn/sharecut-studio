import { opfsFileHandle } from "./opfsPath";
import {
  createSyncWriterHandler,
  errorReply,
  type SyncAccessHandleLike,
  type SyncWriterEngine,
  type SyncWriterInMsg,
  type SyncWriterOutMsg,
} from "./syncWriterProtocol";

export type SyncWriterScope = {
  postMessage(msg: SyncWriterOutMsg): void;
  onmessage: ((ev: MessageEvent<SyncWriterInMsg>) => void) | null;
};

export function createOpfsSyncEngine(): SyncWriterEngine {
  return {
    supported:
      typeof FileSystemFileHandle !== "undefined" &&
      typeof (
        FileSystemFileHandle.prototype as unknown as {
          createSyncAccessHandle?: unknown;
        }
      ).createSyncAccessHandle === "function",
    async openHandle(path: string) {
      const root = await navigator.storage.getDirectory();
      const file = await opfsFileHandle(root, path, true);
      return (
        file as unknown as {
          createSyncAccessHandle(): Promise<SyncAccessHandleLike>;
        }
      ).createSyncAccessHandle();
    },
    now: () => performance.now(),
  };
}

export function startSyncWriterWorker(
  scope: SyncWriterScope,
  engine: SyncWriterEngine = createOpfsSyncEngine(),
): void {
  const handle = createSyncWriterHandler(engine);
  scope.postMessage({ type: "ready", supported: engine.supported });
  let chain: Promise<void> = Promise.resolve();
  scope.onmessage = (ev) => {
    const { id } = ev.data;
    // A reply that cannot be posted (e.g. DataCloneError) must not wedge later
    // requests; answer this one with an error so the client need not time out.
    chain = chain
      .then(async () => scope.postMessage(await handle(ev.data)))
      .catch((error: unknown) => {
        try {
          scope.postMessage(errorReply(id, error));
        } catch {
          // Worker is tearing down; the client's deadline covers this request.
        }
      });
  };
}

// Started only inside a real worker; tests call startSyncWriterWorker().
if (
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
  "undefined"
) {
  startSyncWriterWorker(globalThis as unknown as SyncWriterScope);
}
