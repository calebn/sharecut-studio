/** `rem` in CSS pixels at the document's root font size. */
export function remToPx(rem: number): number {
  if (typeof document === "undefined") {
    return rem * 16;
  }
  const root = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize || "16",
  );
  return rem * (Number.isFinite(root) && root > 0 ? root : 16);
}
