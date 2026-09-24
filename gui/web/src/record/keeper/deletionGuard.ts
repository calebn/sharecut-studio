import type { ByteSink } from "./store";

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
async function removeLocally(
  sink: ByteSink,
  wavPath: string,
): Promise<"removed" | "held"> {
  if (keeperReclaimHeld(sink)) return "held";
  const op = sink.remove(wavPath);
  let ops = inflight.get(sink);
  if (!ops) {
    ops = new Set();
    inflight.set(sink, ops);
  }
  ops.add(op);
  try {
    await op;
    return "removed";
  } finally {
    ops.delete(op);
  }
}

export async function removeKeeperUnlessHeld(
  sink: ByteSink,
  wavPath: string,
): Promise<"removed" | "held"> {
  if (keeperReclaimHeld(sink)) return "held";
  if (!sink.deletionLockName) return removeLocally(sink, wavPath);
  const locks = deletionLocks(sink);
  // Without origin-wide coordination, leaving a WAV is safer than deleting
  // another tab's pending recovery download.
  if (!locks) return "held";
  return locks.request(
    sink.deletionLockName,
    { mode: "exclusive", ifAvailable: true },
    (lock) => (lock ? removeLocally(sink, wavPath) : "held"),
  );
}
