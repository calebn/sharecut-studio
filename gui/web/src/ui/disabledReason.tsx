import { useId } from "react";

/**
 * A shared control is disabled only by giving the reason. Its props omit the
 * native `disabled`, so a dead control without an explanation does not
 * type-check (docs/communication-philosophy.md, "Gated actions are disabled
 * with the reason in place"). Write the reason as what is missing and what to
 * do, for example "Add a name to save."
 */
export type DisabledReasonProps = {
  disabledReason?: string;
};

/** Reason for a control that waits on an action already running. */
export const BUSY_REASON = "Wait for the current action to finish.";

export function useDisabledReason(
  reason: string | undefined,
  describedBy?: string,
) {
  const reasonId = useId();
  const disabled = reason !== undefined && reason !== "";
  return {
    attrs: disabled
      ? {
          disabled: true,
          title: reason,
          "aria-describedby": describedBy
            ? `${describedBy} ${reasonId}`
            : reasonId,
        }
      : {},
    note: disabled ? (
      <span id={reasonId} hidden>
        {reason}
      </span>
    ) : null,
  };
}
