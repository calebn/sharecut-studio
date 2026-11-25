export type TimeRange = { start: number; end: number };

function cutTenths(sec: number): number {
  return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) : 0;
}

export function hasCutsSaved(sec: number): boolean {
  return cutTenths(sec) > 0;
}

export function formatCutsSaved(sec: number): string {
  if (!hasCutsSaved(sec)) return "No cuts yet";
  const tenths = cutTenths(sec);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s shorter`;
  const total = Math.round(sec);
  const min = Math.floor(total / 60);
  const rest = total % 60;
  if (min === 0) return `${rest} s shorter`;
  return rest === 0 ? `${min} min shorter` : `${min} min ${rest} s shorter`;
}

/** 2.94 is "2.9 s". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}
