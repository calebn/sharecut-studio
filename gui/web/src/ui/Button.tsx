import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "link";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
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
  { variant = "default", className, type = "button", children, ...rest },
  ref,
) {
  const base = classForVariant(variant);
  return (
    <button
      ref={ref}
      type={type}
      className={className ? `${base} ${className}` : base}
      {...rest}
    >
      {children}
    </button>
  );
});
