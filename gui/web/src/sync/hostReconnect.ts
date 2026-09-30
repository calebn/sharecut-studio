export function hostReconnectDelay(
  attempt: number,
  random = Math.random(),
): number {
  const ceiling = Math.min(
    30_000,
    500 * 2 ** Math.min(6, Math.max(0, attempt)),
  );
  return ceiling * (0.5 + Math.min(1, Math.max(0, random)) * 0.5);
}
