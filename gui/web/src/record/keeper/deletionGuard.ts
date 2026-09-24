import type { ByteSink } from "./store";

const holds = new WeakMap<ByteSink, number>();
const inflight = new WeakMap<ByteSink, Set<Promise<unknown>>>();

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
  const pending = inflight.get(sink);
  if (pending?.size) await Promise.allSettled([...pending]);
  return release;
}

/** Start and register deletion without an await gap after the hold check. */
export async function removeKeeperUnlessHeld(
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
