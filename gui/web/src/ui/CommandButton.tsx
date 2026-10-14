import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button, type ButtonVariant } from "./Button";
import { type DisabledReasonProps, disabledAttrs } from "./disabledReason";
import { useCommand } from "./useCommand";

type WhenGate =
  | { respectWhen?: false; whenReason?: never }
  | {
      /** Disable when the command's keyboard `when` fails. Pointer default skips it. */
      respectWhen: true;
      /** What the person reads when the `when` gate holds the command back. */
      whenReason: string;
    };

type BaseProps = {
  commandId: string;
  args?: Record<string, unknown>;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "disabled"> &
  DisabledReasonProps &
  WhenGate;

export type CommandButtonProps = BaseProps & {
  /** Plain button for domain chrome (play-btn, transport-icon-btn). */
  bare?: boolean;
  variant?: ButtonVariant;
};

/**
 * Pointer bridge to the command bus. Does not register key listeners.
 */
export function CommandButton({
  commandId,
  args,
  respectWhen = false,
  whenReason,
  children,
  disabledReason,
  onClick,
  bare = false,
  variant = "default",
  className,
  ...rest
}: CommandButtonProps) {
  const { run, enabled, label } = useCommand(commandId);
  const reason =
    disabledReason || (respectWhen && !enabled ? whenReason : undefined);
  const isDisabled = Boolean(reason);
  const attrs = disabledAttrs(reason);

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || isDisabled) {
      return;
    }
    void run(args, { skipWhen: !respectWhen });
  };

  const content = children ?? label;

  if (bare) {
    const bareClass = className ? `ui-control ${className}` : "ui-control";
    return (
      <button
        type="button"
        {...rest}
        {...attrs}
        className={bareClass}
        onClick={handleClick}
      >
        {content}
      </button>
    );
  }

  return (
    <Button
      variant={variant}
      className={className}
      {...rest}
      disabledReason={reason}
      onClick={handleClick}
    >
      {content}
    </Button>
  );
}
