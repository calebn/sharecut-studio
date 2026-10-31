import { type KeyboardEvent, useEffect, useId, useRef } from "react";
import { Button } from "../ui";

/** One take of a pickup. `refusal` is why Accept would not place it. */
export type TakeOption = {
  takeIndex: number;
  /** "12.3 s" */
  length?: string;
  /** "34 words" */
  words?: string;
  snippet?: string;
  refusal?: string;
};

export type TakeSwitcherProps = {
  /** In take order. */
  takes: readonly TakeOption[];
  /** The `takeIndex` Accept places. */
  selected: number;
  onSelect: (takeIndex: number) => void;
};

/** Marks a group that keeps the arrow keys, so the stage does not step on to the next item. */
export const OWN_ARROWS = "data-own-arrows";

const PREVIOUS_REASON = "This is the first take.";
const NEXT_REASON = "This is the last take.";

/**
 * "Take 2 of 3" with Previous and Next, and the length and first words of the
 * take under it. Arrow keys move only while focus is inside the group.
 */
export function TakeSwitcher({ takes, selected, onSelect }: TakeSwitcherProps) {
  const labelId = useId();
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const had = useRef<"previous" | "next" | null>(null);
  const at = Math.max(
    0,
    takes.findIndex((take) => take.takeIndex === selected),
  );
  const take = takes[at];
  const before = takes[at - 1];
  const after = takes[at + 1];
  const reasonBefore = before
    ? before.refusal
      ? `Take ${at} cannot be placed: ${before.refusal}`
      : undefined
    : PREVIOUS_REASON;
  const reasonAfter = after
    ? after.refusal
      ? `Take ${at + 2} cannot be placed: ${after.refusal}`
      : undefined
    : NEXT_REASON;

  useEffect(() => {
    // A button that just went disabled drops focus; hand it to the other one.
    const gone = had.current;
    had.current = null;
    if (!gone) return;
    const [lost, other] =
      gone === "previous" ? [previous, next] : [next, previous];
    if (lost.current?.disabled && !other.current?.disabled)
      other.current?.focus({ preventScroll: true });
  }, [selected]);

  if (!take) return null;
  const go = (side: "previous" | "next") => {
    const target = side === "previous" ? before : after;
    if (!target || target.refusal) return;
    had.current = side;
    onSelect(target.takeIndex);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    if (!back && !forward) return;
    event.preventDefault();
    event.stopPropagation();
    go(back ? "previous" : "next");
  };
  const facts = [take.length, take.words].filter(Boolean).join(" · ");

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of two buttons, not a fieldset
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the arrows move between the group's own buttons
    <div
      className="sys-take-switcher"
      role="group"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      {...{ [OWN_ARROWS]: "" }}
    >
      <div className="sys-take-switcher-row">
        <Button
          ref={previous}
          aria-label="Previous take"
          disabledReason={reasonBefore}
          onClick={() => go("previous")}
        >
          Previous
        </Button>
        <span
          id={labelId}
          className="sys-take-switcher-label sys-mono"
          aria-live="polite"
        >
          Take {at + 1} of {takes.length}
        </span>
        <Button
          ref={next}
          aria-label="Next take"
          disabledReason={reasonAfter}
          onClick={() => go("next")}
        >
          Next
        </Button>
      </div>
      {facts ? (
        <p className="sys-take-switcher-facts sys-mono">{facts}</p>
      ) : null}
      {take.snippet ? (
        <p className="sys-take-switcher-snippet">“{take.snippet}”</p>
      ) : null}
      {take.refusal ? (
        <p className="sys-take-switcher-refusal" role="note">
          Replace is not available for this take: {take.refusal}
        </p>
      ) : null}
    </div>
  );
}
