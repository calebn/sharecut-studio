import type { ComponentPropsWithoutRef } from "react";
import { unavailableReason, useDisabledReasonNote } from "../ui/disabledReason";

type NudgeButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "className" | "type" | "aria-label"
>;

/** Why nudges wait while a typed value is not applied yet. */
export const UNAPPLIED_VALUE_REASON = "Apply or clear the typed value first.";

export interface NudgeButtonsProps {
  /** Accessible name of the button group. */
  groupLabel: string;
  deltas: readonly number[];
  /** What a button says, for example "+10". */
  text: (delta: number) => string;
  /** Accessible name of one button, for example "100 ms earlier". */
  label: (delta: number) => string;
  /** The gesture handlers for one delta (`useNudgeRun().buttonProps`). */
  propsFor: (delta: number) => NudgeButtonProps;
  /**
   * Why the nudges cannot run, as what is missing and what to do. While set,
   * every button stays focusable, says so with `aria-disabled`, shows the
   * reason beside the group and refuses to nudge.
   */
  unavailable?: string;
  /**
   * A save is in flight. The buttons refuse to nudge (`aria-disabled`) but show
   * no note, so the rows below do not jump on every release.
   */
  saving?: boolean;
  onPointerDownCapture?: () => void;
}

/**
 * The step buttons of a nudge row. An unavailable button is not natively
 * disabled: it stays reachable by key and touch and the reason is visible and
 * described, like `ui/Menu` items.
 */
export function NudgeButtons({
  groupLabel,
  deltas,
  text,
  label,
  propsFor,
  unavailable,
  saving = false,
  onPointerDownCapture,
}: NudgeButtonsProps) {
  const reason = unavailableReason(unavailable);
  const { note, describedBy } = useDisabledReasonNote(reason);
  return (
    <>
      <div
        className="nudge-row-buttons"
        onPointerDownCapture={
          reason || saving ? undefined : onPointerDownCapture
        }
        role="group"
        aria-label={groupLabel}
      >
        {deltas.map((delta) => (
          <button
            key={delta}
            type="button"
            className="ui-control nudge-button"
            aria-label={label(delta)}
            {...(reason
              ? {
                  "aria-disabled": true,
                  onClick: (event) => event.preventDefault(),
                  ...describedBy,
                }
              : saving
                ? {
                    "aria-disabled": true,
                    onClick: (event) => event.preventDefault(),
                  }
                : propsFor(delta))}
          >
            {text(delta)}
          </button>
        ))}
      </div>
      {note}
    </>
  );
}
