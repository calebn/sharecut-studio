import type { ButtonHTMLAttributes, ReactNode } from "react";
import { type DisabledReasonProps, useDisabledReason } from "./disabledReason";

type Props = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-pressed" | "disabled"
> &
  DisabledReasonProps & {
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
  disabledReason,
  children,
  ...rest
}: Props) {
  const { attrs, note } = useDisabledReason(
    disabledReason,
    rest["aria-describedby"],
  );
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
    <>
      <button
        type={type}
        className={classes}
        {...rest}
        {...attrs}
        {...stateProps}
      >
        {children}
      </button>
      {note}
    </>
  );
}
