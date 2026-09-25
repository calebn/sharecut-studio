/** Messages between keeper `syncWriterClient` and `syncWriter.worker` (one worker per open segment). */
export const KEEPER_FLUSH_INTERVAL_MS = 2_000;

export type SyncWriterInMsg =
  | { type: "open"; id: number; path: string }
  | { type: "write"; id: number; bytes: ArrayBuffer; offset: number }
  | { type: "close"; id: number };

export type SyncWriterOutMsg =
  | { type: "ready"; supported: boolean }
  | { type: "result"; id: number }
  | { type: "error"; id: number; name: string; message: string };

/** Structural subset of FileSystemSyncAccessHandle; methods may return promises on Safari < 16.4. */
export type SyncAccessHandleLike = {
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
};

export type SyncWriterEngine = {
  supported: boolean;
  openHandle(path: string): Promise<SyncAccessHandleLike>;
  now(): number;
};

/** Thrown by the client when in-place writes are unavailable; the sink falls back to createWritable. */
export class SyncWriterUnavailableError extends Error {
  constructor() {
    super("In-place OPFS writes are unavailable.");
    this.name = "SyncWriterUnavailableError";
  }
}

export function createSyncWriterHandler(
  engine: SyncWriterEngine,
): (msg: SyncWriterInMsg) => Promise<SyncWriterOutMsg> {
  let handle: SyncAccessHandleLike | null = null;
  let flushedAt = 0;
  return async (msg) => {
    try {
      if (msg.type === "open") {
        if (handle) {
          throw new Error("keeper writer already open");
        }
        handle = await engine.openHandle(msg.path);
        flushedAt = engine.now();
      } else if (msg.type === "write") {
        if (!handle) {
          throw new Error("keeper writer is not open");
        }
        const bytes = new Uint8Array(msg.bytes);
        const n = handle.write(bytes, { at: msg.offset });
        if (n !== bytes.byteLength) {
          throw new Error(
            `keeper short write: ${n} of ${bytes.byteLength} bytes`,
          );
        }
        if (engine.now() - flushedAt >= KEEPER_FLUSH_INTERVAL_MS) {
          await handle.flush();
          flushedAt = engine.now();
        }
      } else if (handle) {
        const h = handle;
        handle = null;
        try {
          await h.flush();
        } finally {
          await h.close();
        }
      }
      return { type: "result", id: msg.id };
    } catch (error) {
      return {
        type: "error",
        id: msg.id,
        name: errorField(error, "name") ?? "Error",
        message: errorField(error, "message") ?? String(error),
      };
    }
  };
}

/** Duck-typed so a DOMException from another realm keeps its name. */
function errorField(error: unknown, key: "name" | "message"): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}
