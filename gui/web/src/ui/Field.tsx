import type { ReactNode } from "react";
import { InlineError } from "./InlineError";

type Props = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
};

/** Labeled control with optional hint and InlineError. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: Props) {
  return (
    <div className={className ? `ui-field ${className}` : "ui-field"}>
      <label className="ui-field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="ui-field-control">{children}</div>
      {hint ? <p className="ui-field-hint">{hint}</p> : null}
      <InlineError message={error} />
    </div>
  );
}
