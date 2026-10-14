import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import { type DisabledReasonProps, useDisabledReason } from "./disabledReason";

export type ButtonVariant = "default" | "primary" | "danger" | "link";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> &
  DisabledReasonProps & {
    variant?: ButtonVariant;
    children: ReactNode;
  };

function classForVariant(variant: ButtonVariant): string {
  if (variant === "link") {
    return "ui-control linkish";
  }
  if (variant === "primary") {
    return "ui-control modifier-action primary";
  }
  if (variant === "danger") {
    return "ui-control modifier-action danger";
  }
  return "ui-control modifier-action";
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "default",
    className,
    type = "button",
    disabledReason,
    children,
    ...rest
  },
  ref,
) {
  const base = classForVariant(variant);
  const { attrs, note } = useDisabledReason(
    disabledReason,
    rest["aria-describedby"],
  );
  return (
    <>
      <button
        ref={ref}
        type={type}
        className={className ? `${base} ${className}` : base}
        {...rest}
        {...attrs}
      >
        {children}
      </button>
      {note}
    </>
  );
});
