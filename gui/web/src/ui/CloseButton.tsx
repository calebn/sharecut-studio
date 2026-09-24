import { type ButtonHTMLAttributes, forwardRef } from "react";
import { Icon } from "./Icon";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/**
 * The one close affordance for Dialog and BottomSheet: a borderless icon
 * button named "Close" (Esc also dismisses). A bare ui-control, not a
 * modifier-action, so page-level action sizing never turns it into a pill.
 */
export const CloseButton = forwardRef<HTMLButtonElement, Props>(
  function CloseButton({ className, title = "Close (Esc)", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={
          className
            ? `ui-control dialog-close ${className}`
            : "ui-control dialog-close"
        }
        aria-label="Close"
        title={title}
        {...rest}
      >
        <Icon name="close" />
      </button>
    );
  },
);
