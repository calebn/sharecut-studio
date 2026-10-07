import type { ByteSink, ByteStream } from "./store";

const holds = new WeakMap<ByteSink, number>();
const inflight = new WeakMap<ByteSink, Set<Promise<unknown>>>();

function deletionLocks(sink: ByteSink): LockManager | null {
  return sink.deletionLockName ? (navigator.locks ?? null) : null;
}

/** A shared origin lock stays held until the browser finishes using lazy Files. */
async function holdAcrossTabs(
  name: string,
  locks: LockManager,
): Promise<() => void> {
  let unlock: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  let acquired: (release: () => void) => void = () => undefined;
  let failed: (error: unknown) => void = () => undefined;
  const ready = new Promise<() => void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  void locks
    .request(name, { mode: "shared" }, async () => {
      acquired(unlock);
      await released;
    })
    .catch(failed);
  return ready;
}

export function keeperReclaimHeld(sink: ByteSink): boolean {
  return (holds.get(sink) ?? 0) > 0;
}

/** Hold all keeper deletion while an archive keeps lazy OPFS File references. */
export async function holdKeeperReclaim(sink: ByteSink): Promise<() => void> {
  holds.set(sink, (holds.get(sink) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = (holds.get(sink) ?? 1) - 1;
    if (next > 0) holds.set(sink, next);
    else holds.delete(sink);
  };
  try {
    const pending = inflight.get(sink);
    if (pending?.size) await Promise.allSettled([...pending]);
    const locks = deletionLocks(sink);
    const unlock =
      locks && sink.deletionLockName
        ? await holdAcrossTabs(sink.deletionLockName, locks)
        : null;
    return () => {
      release();
      unlock?.();
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Start and register deletion without an await gap after the hold check. */
async function deleteLocally<T>(
  sink: ByteSink,
  operation: () => Promise<T>,
): Promise<{ held: true } | { held: false; value: T }> {
  if (keeperReclaimHeld(sink)) return { held: true };
  const op = operation();
  let ops = inflight.get(sink);
  if (!ops) {
    ops = new Set();
    inflight.set(sink, ops);
  }
  ops.add(op);
  try {
    return { held: false, value: await op };
  } finally {
    ops.delete(op);
  }
}

/** Rechecks, marker publication and unlink share one exclusive origin lock. */
export async function withKeeperDeletion<T>(
  sink: ByteSink,
  operation: () => Promise<T>,
): Promise<{ held: true } | { held: false; value: T }> {
  if (keeperReclaimHeld(sink)) return { held: true };
  if (!sink.deletionLockName) return deleteLocally(sink, operation);
  const locks = deletionLocks(sink);
  // Without origin-wide coordination, leaving a WAV is safer than deleting
  // another tab's pending recovery download.
  if (!locks) return { held: true };
  return locks.request(
    sink.deletionLockName,
    { mode: "exclusive", ifAvailable: true },
    (lock) => (lock ? deleteLocally(sink, operation) : { held: true }),
  );
}

export async function removeKeeperUnlessHeld(
  sink: ByteSink,
  wavPath: string,
): Promise<"removed" | "held"> {
  const result = await withKeeperDeletion(sink, () => sink.remove(wavPath));
  return result.held ? "held" : "removed";
}

/** Acquire before opening/creating a WAV; retain protection through teardown. */
export async function openGuardedKeeperStream(
  sink: ByteSink,
  open: () => Promise<ByteStream>,
): Promise<ByteStream> {
  const release = await holdKeeperReclaim(sink);
  let stream: ByteStream;
  try {
    stream = await open();
  } catch (error) {
    release();
    throw error;
  }
  let ended = false;
  let finished = false;
  let aborting: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const abort = (): Promise<void> => {
    if (finished) return Promise.resolve();
    if (aborting) return aborting;
    ended = true;
    // Sync writer abort terminates its worker synchronously; fallback abort
    // awaits swap-file cleanup. Do not unlock before either has finished.
    aborting = (async () => {
      if (stream.abort) await stream.abort();
      else await stream.close();
      finished = true;
      release();
    })();
    return aborting;
  };
  return {
    async write(bytes, offset) {
      if (ended) throw new Error("The full-quality recording writer is closed");
      try {
        await stream.write(bytes, offset);
      } catch (error) {
        await abort().catch(() => undefined);
        throw error;
      }
    },
    close() {
      if (closing) return closing;
      if (ended) return aborting ?? Promise.resolve();
      ended = true;
      closing = (async () => {
        try {
          await stream.close();
          finished = true;
          release();
        } catch (error) {
          await abort().catch(() => undefined);
          throw error;
        }
      })();
      return closing;
    },
    abort() {
      return abort().catch(() => undefined);
    },
  };
}
