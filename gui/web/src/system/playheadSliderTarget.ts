import { clamp } from "../utils/math";

export function playheadSliderTarget(
  key: string,
  position: number,
  maximum: number,
  arrowStep: number,
  pageStep: number,
): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return clamp(position + arrowStep, 0, maximum);
    case "ArrowLeft":
    case "ArrowDown":
      return clamp(position - arrowStep, 0, maximum);
    case "PageUp":
      return clamp(position + pageStep, 0, maximum);
    case "PageDown":
      return clamp(position - pageStep, 0, maximum);
    case "Home":
      return 0;
    case "End":
      return maximum;
    default:
      return null;
  }
}
