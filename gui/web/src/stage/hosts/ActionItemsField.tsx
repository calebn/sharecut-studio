import { useEffect, useRef } from "react";
import { Button } from "../../ui";

export const MAX_ACTION_ITEMS = 5;
export const MAX_ACTION_LENGTH = 120;

/** The non-empty lines, trimmed, in order. */
export function filledActions(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines
    .map((l) => l.trim())
    .filter((l) => {
      const key = l.toLowerCase();
      if (!l || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const root = useRef<HTMLDivElement>(null);
  // Where focus goes once the row or link it was on is gone: a row index, or the Add link.
  const next = useRef<number | "add" | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change of the lines
  useEffect(() => {
    const to = next.current;
    next.current = null;
    if (to === null || !root.current) return;
    const inputs = root.current.querySelectorAll<HTMLInputElement>("input");
    const target =
      to === "add"
        ? root.current.querySelector<HTMLElement>("button:last-child")
        : (inputs[Math.min(to, inputs.length - 1)] ?? null);
    (target ?? root.current).focus();
  }, [lines]);
  return (
    <div
      className="rv-actions"
      role="group"
      aria-label="Action items"
      ref={root}
      tabIndex={-1}
    >
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
              if (disabled) return;
              next.current = lines.length > 1 ? i : "add";
              onChange(lines.filter((_, j) => j !== i));
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
            if (disabled) return;
            next.current = lines.length;
            onChange([...lines, ""]);
          }}
        >
          Add action item
        </Button>
      ) : null}
    </div>
  );
}
