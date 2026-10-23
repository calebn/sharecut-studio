import { type ReactNode, useId } from "react";

/**
 * A shared control is disabled only by giving the reason. Its props omit the
 * native `disabled`, so a dead control without an explanation does not
 * type-check (docs/communication-philosophy.md, "Gated actions are disabled
 * with the reason in place"). Write the reason as what is missing and what to
 * do, for example "Add a name to save."
 *
 * The reason is the control's `title`, which assistive technology reads as its
 * description unless the caller points `aria-describedby` at a visible note.
 * Place that visible note beside the control where there is room (touch has no
 * hover).
 */
export type DisabledReasonProps = {
  disabledReason?: string;
};

export const UNAVAILABLE_REASON = "This action is unavailable right now.";

export function unavailableReason(
  reason: string | undefined,
): string | undefined {
  if (reason === undefined) return undefined;
  return reason.trim() === "" ? UNAVAILABLE_REASON : reason;
}

/** Reason for a control that waits on an action already running. */
export const BUSY_REASON = "Wait for the current action to finish.";

export function disabledAttrs(reason: string | undefined) {
  const normalized = unavailableReason(reason);
  return normalized === undefined ? {} : { disabled: true, title: normalized };
}

/**
 * A visible note for a disabled control's reason, wired to the control with
 * `aria-describedby`. Place `note` beside the control and spread
 * `describedBy` onto it. Both are absent when there is no reason.
 */
export function useDisabledReasonNote(reason: string | null | undefined): {
  note: ReactNode;
  describedBy: { "aria-describedby": string } | Record<string, never>;
} {
  const id = useId();
  const text = unavailableReason(reason ?? undefined);
  if (text === undefined) return { note: null, describedBy: {} };
  return {
    note: (
      <p id={id} className="export-dialog-note">
        {text}
      </p>
    ),
    describedBy: { "aria-describedby": id },
  };
}
