/**
 * Run `fn` with a signal that aborts after `ms` with a `TimeoutError`
 * DOMException carrying `message`. The timer is cleared once `fn` settles, so
 * work inside `fn` (such as reading a response body) stays under the timeout.
 * When the timeout fired, the call rejects with that `TimeoutError` whatever
 * `fn` rejected with: WebKit's `fetch` rejects with a generic AbortError
 * ("Fetch is aborted") instead of the abort reason.
 *
 * A caller's `cancel` signal aborts the same signal with its own reason. Pass
 * it here and never merge signals with the static `any` combinator: on WebKit a
 * combined signal that nothing else references stops forwarding aborts, so a
 * fetch holding it never learns of the timeout and never rejects.
 */
export async function withAbortTimeout<T>(
  ms: number,
  message: string,
  fn: (signal: AbortSignal) => Promise<T>,
  cancel?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(message, "TimeoutError")),
    ms,
  );
  const onCancel = () => controller.abort(cancel?.reason);
  if (cancel?.aborted) onCancel();
  else cancel?.addEventListener("abort", onCancel, { once: true });
  try {
    return await fn(controller.signal);
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener("abort", onCancel);
  }
}
