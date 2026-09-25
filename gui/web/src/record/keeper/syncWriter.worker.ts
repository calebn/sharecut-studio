import { opfsFileHandle } from "./opfsPath";
import {
  createSyncWriterHandler,
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
    chain = chain.then(async () => scope.postMessage(await handle(ev.data)));
  };
}

// Started only inside a real worker; tests call startSyncWriterWorker().
if (
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
  "undefined"
) {
  startSyncWriterWorker(globalThis as unknown as SyncWriterScope);
}
