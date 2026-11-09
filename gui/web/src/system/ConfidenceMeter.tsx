const SLOTS = [1, 2, 3, 4, 5] as const;
export const CONFIDENCE_DOTS = SLOTS.length;

export function confidenceDots(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.round(Math.min(1, Math.max(0, confidence)) * CONFIDENCE_DOTS);
}

/** How sure the suggester is, in five dots. The number stays in the label for assistive tech only. */
export function ConfidenceMeter({
  confidence,
  label = "Confidence",
}: {
  confidence: number;
  label?: string;
}) {
  const filled = confidenceDots(confidence);
  return (
    <span
      className="sys-confidence"
      role="img"
      aria-label={`${label} ${filled} of ${CONFIDENCE_DOTS}`}
    >
      <span className="sys-confidence-label" aria-hidden="true">
        {label}
      </span>
      {SLOTS.map((slot) => (
        <span
          key={slot}
          className="sys-confidence-dot"
          data-filled={slot <= filled ? "true" : undefined}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
