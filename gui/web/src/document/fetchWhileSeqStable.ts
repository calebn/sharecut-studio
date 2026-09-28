import { currentDocumentSeq } from "./cursor";

/**
 * Run `load` until no live document update (`currentDocumentSeq()`) lands
 * while it is in flight, so a GET that carries no `server_seq` never
 * overwrites a newer live update. Resolves `{ value }` from the first stable
 * load, or `null` when `isCancelled()` turns true (checked after each load
 * and after each backoff) or every attempt raced a live update. Errors from
 * `load` propagate. Shared by `hooks/useProjectBootstrap.ts` (DETAIL hydrate:
 * unbounded, 150 ms backoff, stops on unmount) and `api/documentEdits.ts`
 * `refreshProjectPhase` (post-409 refresh: 3 tries, no backoff, stops on a
 * project switch); fix edge cases here rather than in a copy.
 */
export async function fetchWhileSeqStable<T>(
  load: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: number;
    isCancelled?: () => boolean;
  } = {},
): Promise<{ value: T } | null> {
  const attempts = opts.attempts ?? Number.POSITIVE_INFINITY;
  const delayMs = opts.delayMs ?? 0;
  const isCancelled = opts.isCancelled ?? (() => false);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (isCancelled()) {
        return null;
      }
    }
    const seqAtStart = currentDocumentSeq();
    const value = await load();
    if (isCancelled()) {
      return null;
    }
    if (currentDocumentSeq() === seqAtStart) {
      return { value };
    }
  }
  return null;
}
