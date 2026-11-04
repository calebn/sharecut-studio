import { Button } from "../../ui";

export const MAX_ACTION_ITEMS = 5;
export const MAX_ACTION_LENGTH = 120;

/** The non-empty lines, trimmed, in order. */
export function filledActions(lines: readonly string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean);
}

/**
 * Short to-dos a comment carries ("Re-record the intro"). Lines start empty;
 * the "Add action item" link adds one, up to five. Empty lines are dropped on post.
 */
export function ActionItemsField({
  lines,
  onChange,
  disabled,
}: {
  lines: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rv-actions" role="group" aria-label="Action items">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are an ordered, unkeyed draft
        <div className="rv-action-row" key={i}>
          <input
            className="rv-action-input"
            type="text"
            value={line}
            maxLength={MAX_ACTION_LENGTH}
            disabled={disabled}
            aria-label={`Action item ${i + 1}`}
            placeholder="What needs doing?"
            onChange={(e) =>
              onChange(lines.map((l, j) => (j === i ? e.target.value : l)))
            }
          />
          <Button
            variant="link"
            aria-disabled={disabled || undefined}
            aria-label={`Remove action item ${i + 1}`}
            onClick={() => {
              if (!disabled) onChange(lines.filter((_, j) => j !== i));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      {lines.length < MAX_ACTION_ITEMS ? (
        <Button
          variant="link"
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onChange([...lines, ""]);
          }}
        >
          Add action item
        </Button>
      ) : null}
    </div>
  );
}
