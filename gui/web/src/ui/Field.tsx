import type { ReactNode } from "react";
import { InlineError } from "./InlineError";

type Props = {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** Match the control's aria-describedby; Field accepts arbitrary children. */
  hintId?: string;
  error?: string | null;
  /** Match the control's aria-describedby; callers also set aria-invalid. */
  errorId?: string;
  children: ReactNode;
  className?: string;
};

/** Labeled control with optional hint and InlineError. */
export function Field({
  label,
  htmlFor,
  hint,
  hintId,
  error,
  errorId,
  children,
  className,
}: Props) {
  return (
    <div className={className ? `ui-field ${className}` : "ui-field"}>
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ui-field-control">{children}</div>
      {hint ? (
        <p id={hintId} className="ui-field-hint">
          {hint}
        </p>
      ) : null}
      <InlineError id={errorId} message={error} />
    </div>
  );
}
