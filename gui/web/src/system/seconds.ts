export type TimeRange = { start: number; end: number };

export function formatCutsSaved(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const tenths = Math.round(s * 10);
  if (tenths === 0) return "No cuts yet";
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s shorter`;
  const total = Math.round(s);
  const min = Math.floor(total / 60);
  const rest = total % 60;
  if (min === 0) return `${rest} s shorter`;
  return rest === 0 ? `${min} min shorter` : `${min} min ${rest} s shorter`;
}

/** 2.94 is "2.9 s". */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`;
}
