export type TimeRange = { start: number; end: number };

function cutTenths(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) : 0;
}

export function hasCutsSaved(sec: number): boolean {
  return cutTenths(sec) > 0;
}

/** Under 10 s one decimal ("3.2 s"); from 10 s whole units ("12 s", "1 min 12 s"). */
export function formatSpan(sec: number): string {
  const tenths = cutTenths(sec);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`;
  const total = Math.round(sec);
  const min = Math.floor(total / 60);
  const rest = total % 60;
  if (min === 0) return `${rest} s`;
  return rest === 0 ? `${min} min` : `${min} min ${rest} s`;
}

export function formatCutsSaved(sec: number): string {
  return hasCutsSaved(sec) ? `${formatSpan(sec)} shorter` : "No cuts yet";
}

/** 2.94 is "2.9 s". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}
