import { getTab, setTab } from "./tabStorage";

type CorruptPolicy = "throw" | "reset";

type MonotonicSeq = { next(): number };

const CORRUPT_MESSAGE =
  "Cannot create this edit because its saved sequence is invalid.";

function parseStored(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

export function createMonotonicSeq(
  key: string,
  options: { onCorrupt: CorruptPolicy },
): MonotonicSeq {
  let floor = 0;
  return {
    next() {
      const raw = getTab(key);
      const stored = raw === null ? 0 : parseStored(raw);
      if (stored === null && options.onCorrupt === "throw") {
        throw new Error(CORRUPT_MESSAGE);
      }
      let base =
        stored === null ? Math.max(floor, Date.now()) : Math.max(stored, floor);
      if (base + 1 >= Number.MAX_SAFE_INTEGER) {
        if (options.onCorrupt === "throw") {
          throw new Error(CORRUPT_MESSAGE);
        }
        base = Date.now();
      }
      const written = setTab(key, String(base + 1));
      const value = written ? base + 1 : Math.max(base + 1, Date.now() + 1);
      floor = value;
      return value;
    },
  };
}

const keyedSeqs = new Map<string, MonotonicSeq>();

/**
 * Entries are never evicted: the map is bounded by the number of distinct
 * storage keys one tab uses (one per record token), and each entry is a closure
 * over a single number.
 */
export function nextSeq(key: string): number {
  let seq = keyedSeqs.get(key);
  if (!seq) {
    seq = createMonotonicSeq(key, { onCorrupt: "reset" });
    keyedSeqs.set(key, seq);
  }
  return seq.next();
}
