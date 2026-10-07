import { type ReactNode, useId } from "react";
import { InlineError } from "./InlineError";

/** Spread onto the field's control: its id, hint and error wiring. */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
};

type Props = {
  label: string;
  hint?: string;
  error?: string | null;
  /** Renders the control; spread `control` onto it so the label, hint and error reach it. */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
};

/**
 * Labeled control with an optional hint and InlineError. Field owns the ids, so
 * the label, the hint and the error always reach the control: it is described
 * by both and is `aria-invalid` while the error shows.
 */
export function Field({ label, hint, error, children, className }: Props) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const control: FieldControlProps = {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
  };
  return (
    <div className={className ? `ui-field ${className}` : "ui-field"}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field-control">{children(control)}</div>
      {hint ? (
        <p id={hintId} className="ui-field-hint">
          {hint}
        </p>
      ) : null}
      <InlineError id={errorId} message={error} />
    </div>
  );
}
