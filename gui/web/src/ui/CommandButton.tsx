import {
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Button, type ButtonVariant } from "./Button";
import { useCommand } from "./useCommand";

type BaseProps = {
  commandId: string;
  args?: Record<string, unknown>;
  /**
   * When true, disable when the command's keyboard `when` fails.
   * Default false — pointer uses skipWhen (historical transport policy).
   */
  respectWhen?: boolean;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

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
  children,
  disabled,
  onClick,
  bare = false,
  variant = "default",
  className,
  ...rest
}: CommandButtonProps) {
  const { run, enabled, label } = useCommand(commandId);
  const isDisabled = Boolean(disabled) || (respectWhen && !enabled);

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
        className={bareClass}
        disabled={isDisabled}
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
      disabled={isDisabled}
      onClick={handleClick}
    >
      {content}
    </Button>
  );
}
