import {
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { useMenuKeyboard } from "./useMenuKeyboard";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

function layoutOpenMenuPanel(trigger: HTMLElement, panel: HTMLElement): void {
  const triggerBottom = trigger.getBoundingClientRect().bottom;
  const nav = document.querySelector(".mobile-nav");
  const bottomLimit =
    nav instanceof HTMLElement
      ? nav.getBoundingClientRect().top
      : window.innerHeight;
  const rootPx = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const gapPx = 0.25 * (rootPx || 16);
  const availablePx = Math.max(0, bottomLimit - triggerBottom - gapPx);
  const rem = rootPx > 0 ? availablePx / rootPx : availablePx;
  panel.style.setProperty("--menu-available-height", `${rem}rem`);
}

/** Props a Menu hands its trigger; spread them onto the trigger button. */
export type MenuTriggerProps = {
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  "aria-controls": string;
  onClick: () => void;
  ref: RefObject<HTMLButtonElement | null>;
};

type MenuProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the menu. */
  label: string;
  /** id of the menu panel (aria-controls on the trigger). */
  menuId?: string;
  trigger: (props: MenuTriggerProps) => ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * Popup menu: outside click closes it; `useMenuKeyboard` owns Escape, arrow
 * keys and focus restore.
 */
export function Menu({
  open,
  onOpenChange,
  label,
  menuId: menuIdProp,
  trigger,
  children,
  className,
}: MenuProps) {
  const autoId = useId();
  const menuId = menuIdProp ?? autoId;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const layout = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) {
        return;
      }
      layoutOpenMenuPanel(trigger, panel);
    };
    layout();
    window.addEventListener("resize", layout);
    return () => {
      window.removeEventListener("resize", layout);
    };
  }, [open]);

  useMenuKeyboard({ open, panelRef, close });

  useOutsidePointerDown([panelRef, triggerRef], close, open);

  return (
    <div
      className={className ?? "ui-menu-root"}
      onPointerDown={(event) => {
        if (
          open &&
          event.target instanceof Node &&
          triggerRef.current?.contains(event.target)
        ) {
          event.preventDefault();
        }
      }}
    >
      {trigger({
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": menuId,
        onClick: () => onOpenChange(!open),
        ref: triggerRef,
      })}
      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          className="ui-menu-panel transport-overflow-menu"
          role="menu"
          aria-label={label}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              close();
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = {
  children: ReactNode;
  onSelect?: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  /** Display-only shortcut, right-aligned; hidden from the accessible name. */
  shortcut?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** `aria-keyshortcuts` for the shortcut (the visible kbd is aria-hidden). */
  keyShortcuts?: string;
};

export function MenuItem({
  children,
  onSelect,
  className,
  title,
  disabled,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  shortcut,
  keyShortcuts,
}: MenuItemProps) {
  const classes = ["ui-control", "ui-control--quiet", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={classes}
      title={title}
      aria-keyshortcuts={keyShortcuts}
      disabled={disabled}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={() => {
        if (!disabled) {
          onSelect?.();
        }
      }}
    >
      {shortcut ? (
        <>
          <span className="ui-menu-item-label">{children}</span>
          <kbd className="ui-menu-shortcut" aria-hidden="true">
            {shortcut}
          </kbd>
        </>
      ) : (
        children
      )}
    </button>
  );
}

type MenuSectionProps = {
  label: string;
  children: ReactNode;
};

/**
 * Labeled group for menuitems, checkable menuitems, and supporting notes.
 */
export function MenuSection({ label, children }: MenuSectionProps) {
  return (
    <div className="ui-menu-section" role="group" aria-label={label}>
      <div className="ui-menu-section-label" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}
