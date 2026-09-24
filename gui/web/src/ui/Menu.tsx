import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { noteMenuOpen } from "./menuGate";
import { listFocusable } from "./useDialogModal";

function menuItems(panel: HTMLElement): HTMLElement[] {
  return listFocusable(panel).filter(
    (el) =>
      el.getAttribute("role") === "menuitem" ||
      el.getAttribute("role") === "menuitemcheckbox" ||
      el.getAttribute("role") === "menuitemradio",
  );
}

function focusMenuItem(el: HTMLElement): void {
  el.focus();
  el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

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
 * Popup menu: Escape, outside click, arrow keys, focus restore.
 * GOVERNANCE: window keydown — allowlisted via this module.
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
  const restoreRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) {
      return;
    }
    noteMenuOpen(true);
    return () => {
      noteMenuOpen(false);
    };
  }, [open]);

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

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const items = menuItems(panel);
      const first = items[0] ?? listFocusable(panel)[0];
      if (first) {
        focusMenuItem(first);
      }
    };
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const items = menuItems(panel);
      if (items.length === 0) {
        return;
      }
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusMenuItem(items[(idx + 1 + items.length) % items.length]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusMenuItem(items[(idx - 1 + items.length) % items.length]);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusMenuItem(items[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        focusMenuItem(items[items.length - 1]);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) {
        return;
      }
      close();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      // Take focus back only when it left with the panel. When another menu's
      // trigger took it (exclusive menus), stealing it back would make that
      // menu record this trigger as the place Escape returns to.
      const active = document.activeElement;
      const focusLost =
        !active || active === document.body || !active.isConnected;
      const restore = restoreRef.current;
      if (focusLost && restore?.isConnected) {
        restore.focus();
      }
    };
  }, [open, close]);

  return (
    <div className={className ?? "ui-menu-root"}>
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
