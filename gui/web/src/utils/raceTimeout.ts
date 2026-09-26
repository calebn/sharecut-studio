/**
 * Settle with `promise`, or with `onTimeout()` if `ms` passes first (a throw
 * from `onTimeout` rejects). The timer is always cleared; `promise` itself is
 * not cancelled.
 */
export async function raceTimeout<T, F>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
