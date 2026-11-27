/**
 * A counter the inspector's dry run watches. A refused apply (the plan moved
 * on without the history head moving, for example a changed pipeline setting)
 * bumps it, so the row plans again and shows the fresh state and token
 * instead of resending the dead one.
 */
let count = 0;
const listeners = new Set<() => void>();

export function requestDuckingReplan(): void {
  count += 1;
  for (const listener of listeners) listener();
}

export function duckingReplanCount(): number {
  return count;
}

export function subscribeDuckingReplan(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
