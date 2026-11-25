/** The Deliver row's wording for a cut total (independent of the app's formatter). */
export function cutsSavedText(sec: number): string {
  const tenths = Math.round(sec * 10);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s shorter`;
  const whole = Math.round(sec);
  const min = Math.floor(whole / 60);
  const rest = whole % 60;
  if (min === 0) return `${rest} s shorter`;
  return rest === 0 ? `${min} min shorter` : `${min} min ${rest} s shorter`;
}
