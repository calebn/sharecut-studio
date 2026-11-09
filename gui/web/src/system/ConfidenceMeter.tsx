const SLOTS = [1, 2, 3, 4, 5] as const;
const CONFIDENCE_DOTS = SLOTS.length;

export function confidenceDots(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return Math.round(Math.min(1, Math.max(0, confidence)) * CONFIDENCE_DOTS);
}

export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const filled = confidenceDots(confidence);
  return (
    <span
      className="sys-confidence"
      role="img"
      aria-label={`Confidence ${filled} of ${CONFIDENCE_DOTS}`}
    >
      <span className="sys-confidence-label" aria-hidden="true">
        Confidence
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
