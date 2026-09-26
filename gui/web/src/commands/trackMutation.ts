let trackMutateChain: Promise<void> = Promise.resolve();

/** Serialize track and clip changes that share the project timeline. */
export function enqueueTrackMutate<T>(fn: () => Promise<T>): Promise<T> {
  const run = trackMutateChain.then(fn, fn);
  trackMutateChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function _resetTrackMutateChainForTests(): void {
  trackMutateChain = Promise.resolve();
}
