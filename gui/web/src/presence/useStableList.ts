import { useState } from "react";

/**
 * The newest `next`, except that an item equal to one already kept (same key,
 * `same` true) keeps the kept object, and the kept array itself comes back when
 * every item did. A later render whose list is equal by value is then a no-op
 * for a memoized child. The previous value is state rather than a ref, so
 * nothing reads a ref during render.
 */
export function useStableList<T>(
  next: readonly T[],
  key: (item: T) => string,
  same: (a: T, b: T) => boolean,
): readonly T[] {
  const [kept, setKept] = useState<readonly T[]>(next);
  const byKey = new Map(kept.map((item) => [key(item), item]));
  const items = next.map((item) => {
    const before = byKey.get(key(item));
    return before !== undefined && same(before, item) ? before : item;
  });
  const unchanged =
    items.length === kept.length &&
    items.every((item, index) => item === kept[index]);
  if (unchanged) {
    return kept;
  }
  setKept(items);
  return items;
}
