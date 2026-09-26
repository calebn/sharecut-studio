export type ClipLedProps = {
  /** Lit when clipping has been detected. */
  lit: boolean;
  /** Show the "Clip"/"Clipped" text beside the LED. */
  showText?: boolean;
  /** Accessible name; without it the LED is decorative (aria-hidden). */
  label?: string;
};

/** Clip indicator LED shared by the level meter and the REC indicator. */
export function ClipLed({ lit, showText = false, label }: ClipLedProps) {
  const a11y = label
    ? {
        role: "img" as const,
        "aria-label": `${label}: ${lit ? "clipping detected" : "no clipping"}`,
      }
    : { "aria-hidden": true as const };
  return (
    <span
      className="ui-meter-clip"
      data-lit={lit}
      data-testid="clip-led"
      {...a11y}
    >
      <span className="ui-meter-clip-led" />
      {showText && (
        <span className="ui-meter-clip-text">{lit ? "Clipped" : "Clip"}</span>
      )}
    </span>
  );
}
