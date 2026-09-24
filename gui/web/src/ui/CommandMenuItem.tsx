import type { ReactNode } from "react";
import { ariaKeyShortcutsFor, displayShortcutFor } from "../keymap/registry";
import { MenuItem } from "./Menu";
import { useCommand } from "./useCommand";

type Props = {
  commandId: string;
  args?: Record<string, unknown>;
  respectWhen?: boolean;
  children?: ReactNode;
  className?: string;
  title?: string;
  /** Called after clicking (e.g. close menu). */
  onSelect?: () => void;
  /**
   * Hover/focus highlight hooks. These do not fire leave/blur when the menu
   * unmounts (select, Escape, outside click). Callers must clear highlight
   * state on menu close (`onOpenChange(false)` / `closeMenu`).
   */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** Show the command's keyboard shortcut (default true when one exists). */
  showShortcut?: boolean;
};

/** Menu item that runs a catalog command then optional onSelect. */
export function CommandMenuItem({
  commandId,
  args,
  respectWhen = false,
  children,
  className,
  title,
  onSelect,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  showShortcut = true,
}: Props) {
  const { run, enabled, label } = useCommand(commandId);
  const disabled = respectWhen && !enabled;
  const shortcut = showShortcut ? displayShortcutFor(commandId) : undefined;
  const keyShortcuts = showShortcut
    ? ariaKeyShortcutsFor(commandId)
    : undefined;

  return (
    <MenuItem
      className={className}
      title={title}
      disabled={disabled}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      shortcut={shortcut}
      keyShortcuts={keyShortcuts}
      onSelect={() => {
        onSelect?.();
        void run(args, { skipWhen: !respectWhen });
      }}
    >
      {children ?? label}
    </MenuItem>
  );
}
