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

/** Reason for a control that waits on an action already running. */
export const BUSY_REASON = "Wait for the current action to finish.";

export function disabledAttrs(reason: string | undefined) {
  return reason === undefined || reason === ""
    ? {}
    : { disabled: true, title: reason };
}
