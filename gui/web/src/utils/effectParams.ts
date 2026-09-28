/** Readable names (and units) for ffmpeg option keys the built-in FX presets use (effects/presets.py); effectParams.test.ts checks every builtin. */
type ParamLabel = { label: string; unit?: string };

const KNOWN: Record<string, ParamLabel> = {
  f: { label: "frequency", unit: "Hz" },
  frequency: { label: "frequency", unit: "Hz" },
  g: { label: "gain", unit: "dB" },
  w: { label: "width" },
  t: { label: "width type" },
  nr: { label: "noise reduction", unit: "dB" },
  nf: { label: "noise floor", unit: "dB" },
};

/**
 * Per-effect overrides where a shared key means something else. `deesser`'s
 * `frequency` is ffmpeg's normalized 0–1 `f`, not Hz (engines/ffmpeg.py).
 *
 * Only the builtin presets are checked (builtinEffectPresets.fixture.json, kept
 * in sync by tests/test_effects_presets.py). Overlay presets from
 * `resolve_presets` and new effects are not: their keys fall back to `KNOWN` /
 * `SUFFIX_UNITS`, so add an entry here when an effect gives a shared key a
 * different unit.
 */
const BY_EFFECT: Record<string, Record<string, ParamLabel>> = {
  deesser: { frequency: { label: "frequency (0–1)" } },
};

const SUFFIX_UNITS: [RegExp, string][] = [
  [/_db$/i, "dB"],
  [/_hz$/i, "Hz"],
  [/_ms$/i, "ms"],
  [/_sec$/i, "s"],
  [/_lufs$/i, "LUFS"],
];

function labelFor(key: string, effect?: string): ParamLabel {
  const override = effect ? BY_EFFECT[effect]?.[key] : undefined;
  if (override) {
    return override;
  }
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

/** One param as "label value unit", e.g. `threshold_db: -18` → "threshold -18 dB". Pass the effect name so per-effect units apply. */
export function formatEffectParam(
  key: string,
  value: unknown,
  effect?: string,
): string {
  const { label, unit } = labelFor(key, effect);
  const { text, isNumber } = formatValue(value);
  return isNumber && unit ? `${label} ${text} ${unit}` : `${label} ${text}`;
}

/** Every param joined with " · "; "" when there are none. Pass the effect name so per-effect units apply. */
export function formatEffectParams(
  params: Record<string, unknown> | null | undefined,
  effect?: string,
): string {
  if (!params) {
    return "";
  }
  return Object.entries(params)
    .map(([key, value]) => formatEffectParam(key, value, effect))
    .join(" · ");
}
