const SLOTS = [1, 2, 3, 4, 5] as const;
const DOTS = SLOTS.length;

function filledDots(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * DOTS);
}

export function DotMeter({
  label,
  value,
  showLabel = true,
}: {
  label: string;
  value: number;
  showLabel?: boolean;
}) {
  const filled = filledDots(value);
  return (
    <span
      className="sys-dots"
      role="img"
      aria-label={`${label} ${filled} of ${DOTS}`}
    >
      {showLabel && (
        <span className="sys-dots-label" aria-hidden="true">
          {label}
        </span>
      )}
      {SLOTS.map((slot) => (
        <span
          key={slot}
          className="sys-dots-dot"
          data-filled={slot <= filled ? "true" : undefined}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
