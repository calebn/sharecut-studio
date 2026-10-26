export type TimeRange = { start: number; end: number };

/** 2.94 is "2.9 s". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}
