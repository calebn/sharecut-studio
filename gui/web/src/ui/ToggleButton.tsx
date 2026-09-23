import type { ButtonHTMLAttributes, ReactNode } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  pressed: boolean;
  /** Quieter chrome (tabs, segmented tools). */
  quiet?: boolean;
  children: ReactNode;
};

/** Tab / filter / mode toggle that mirrors pressed state via `active` class. */
export function ToggleButton({
  pressed,
  quiet = false,
  className,
  type = "button",
  children,
  ...rest
}: Props) {
  const menuitemRadio = rest.role === "menuitemradio";
  const stateProps = menuitemRadio
    ? { "aria-checked": pressed }
    : { "aria-pressed": pressed };
  const classes = [
    "ui-control",
    quiet ? "ui-control--quiet" : "",
    pressed ? "active" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={classes} {...rest} {...stateProps}>
      {children}
    </button>
  );
}
