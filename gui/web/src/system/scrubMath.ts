type ScrubModifiers = {
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

type ScrubBounds = { readonly min?: number; readonly max?: number };

const COARSE = 10;
const FINE = 0.1;
const MINUS = "−";

export function modifierScale({ shiftKey, altKey }: ScrubModifiers): number {
  return (shiftKey ? COARSE : 1) * (altKey ? FINE : 1);
}

export function clamp(value: number, { min, max }: ScrubBounds): number {
  return Math.min(
    max ?? Number.POSITIVE_INFINITY,
    Math.max(min ?? Number.NEGATIVE_INFINITY, value),
  );
}

export function roundTo(value: number, decimals: number): number {
  const scaled = value * 10 ** decimals;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(scaled) / 10 ** decimals || 0;
}

export function placesOf(step: number): number {
  const [mantissa = "", exponent = "0"] = String(step).split("e");
  const fraction = mantissa.split(".")[1] ?? "";
  return Math.max(0, fraction.length - Number(exponent));
}

export function formatScrub(value: number, decimals: number): string {
  return value.toFixed(decimals).replace("-", MINUS);
}

export function parseScrub(text: string, unit?: string): number | null {
  let body = text.trim();
  if (unit && body.endsWith(unit)) body = body.slice(0, -unit.length).trim();
  if (/,\d{3}(\D|$)/.test(body)) return null;
  body = body.replace(MINUS, "-").replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(body)) return null;
  const parsed = Number(body);
  return Number.isFinite(parsed) ? parsed : null;
}

export function inBounds(value: number, bounds: ScrubBounds): boolean {
  return clamp(value, bounds) === value;
}

export function fillRatio(
  value: number,
  { min, max }: Required<ScrubBounds>,
): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export function steppedValue(
  value: number,
  direction: 1 | -1,
  step: number,
  modifiers: ScrubModifiers,
  decimals: number,
  bounds: ScrubBounds,
): number {
  return clamp(
    roundTo(value + direction * step * modifierScale(modifiers), decimals),
    bounds,
  );
}

export function rangeHint(bounds: ScrubBounds, unit?: string): string {
  const suffix = unit ? ` ${unit}` : "";
  if (bounds.min !== undefined && bounds.max !== undefined)
    return `Enter a number from ${formatScrub(bounds.min, placesOf(bounds.min))} to ${formatScrub(bounds.max, placesOf(bounds.max))}${suffix}`;
  if (bounds.min !== undefined)
    return `Enter a number of at least ${formatScrub(bounds.min, placesOf(bounds.min))}${suffix}`;
  if (bounds.max !== undefined)
    return `Enter a number of at most ${formatScrub(bounds.max, placesOf(bounds.max))}${suffix}`;
  return "Enter a number";
}
