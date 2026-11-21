import { clamp } from "../utils/math";

export function sliderSeekTarget(
  { key, shiftKey }: { key: string; shiftKey: boolean },
  value: number,
  max: number,
  step: number,
  largeStep: number,
): number | null {
  const arrowStep = shiftKey ? largeStep : step;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(value + arrowStep, 0, max);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(value - arrowStep, 0, max);
    case "PageUp":
      return clamp(value + largeStep, 0, max);
    case "PageDown":
      return clamp(value - largeStep, 0, max);
    case "Home":
      return 0;
    case "End":
      return max;
    default:
      return null;
  }
}
