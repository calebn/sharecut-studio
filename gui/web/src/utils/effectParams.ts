/** Readable names (and units) for ffmpeg option keys the FX presets use. */
const KNOWN: Record<string, { label: string; unit?: string }> = {
  f: { label: "frequency", unit: "Hz" },
  frequency: { label: "frequency", unit: "Hz" },
  g: { label: "gain", unit: "dB" },
  w: { label: "width" },
  t: { label: "width type" },
};

const SUFFIX_UNITS: [RegExp, string][] = [
  [/_db$/i, "dB"],
  [/_hz$/i, "Hz"],
  [/_ms$/i, "ms"],
  [/_sec$/i, "s"],
];

function labelFor(key: string): { label: string; unit?: string } {
  const known = KNOWN[key];
  if (known) {
    return known;
  }
  for (const [suffix, unit] of SUFFIX_UNITS) {
    if (suffix.test(key)) {
      return { label: key.replace(suffix, "").replace(/_/g, " "), unit };
    }
  }
  return { label: key.replace(/_/g, " ") };
}

function formatValue(value: unknown): { text: string; isNumber: boolean } {
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = Number.isInteger(value)
      ? String(value)
      : String(Number(value.toFixed(2)));
    return { text, isNumber: true };
  }
  if (typeof value === "boolean") {
    return { text: value ? "on" : "off", isNumber: false };
  }
  if (typeof value === "string") {
    return { text: value, isNumber: false };
  }
  if (value === null || value === undefined) {
    return { text: "none", isNumber: false };
  }
  return { text: JSON.stringify(value), isNumber: false };
}

/** One param as "label value unit", e.g. `threshold_db: -18` → "threshold -18 dB". */
export function formatEffectParam(key: string, value: unknown): string {
  const { label, unit } = labelFor(key);
  const { text, isNumber } = formatValue(value);
  return isNumber && unit ? `${label} ${text} ${unit}` : `${label} ${text}`;
}

/** Every param joined with " · "; "" when there are none. */
export function formatEffectParams(
  params: Record<string, unknown> | null | undefined,
): string {
  if (!params) {
    return "";
  }
  return Object.entries(params)
    .map(([key, value]) => formatEffectParam(key, value))
    .join(" · ");
}
