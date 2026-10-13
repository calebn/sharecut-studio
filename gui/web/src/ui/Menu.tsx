import {
  type ReactNode,
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { placeAnchored, tokenPx, visualViewportBox } from "./anchoredPlacement";
import { enterTopLayerPanel } from "./topLayerFloor";
import { useMenuKeyboard } from "./useMenuKeyboard";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

/**
 * Places the open panel against the visual viewport (and above the phone nav
 * when there is one): below the trigger, flipped above it when that side has
 * more room, clamped `--menu-edge-margin` inside every edge. The panel is a
 * `popover` in the top layer, so no sheet's overflow, size container or
 * stacking context between it and the trigger can clip or bury it.
 */
function layoutOpenMenuPanel(trigger: HTMLElement, panel: HTMLElement): void {
  const viewport = visualViewportBox(document.querySelector(".mobile-nav"));
  const natural = {
    width: panel.offsetWidth,
    height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
  };
  const placed = placeAnchored(
    trigger.getBoundingClientRect(),
    natural,
    viewport,
    {
      margin: tokenPx(panel, "--menu-edge-margin"),
      gap: tokenPx(panel, "--menu-anchor-gap"),
      align: "end",
    },
  );
  const rootPx =
    Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
    16;
  const set = (name: string, value: string) => {
    if (panel.style.getPropertyValue(name) !== value) {
      panel.style.setProperty(name, value);
    }
  };
  set("left", `${placed.left}px`);
  set("top", `${placed.top}px`);
  set("--menu-available-height", `${placed.maxHeight / rootPx}rem`);
  set("--menu-available-width", `${placed.maxWidth / rootPx}rem`);
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const attachPanel = useCallback((panel: HTMLDivElement) => {
    panelRef.current = panel;
    const topLayer = typeof panel.showPopover === "function";
    if (topLayer) {
      panel.showPopover();
    }
    const leave = enterTopLayerPanel();
    return () => {
      leave();
      if (topLayer) {
        panel.hidePopover();
      }
      panelRef.current = null;
    };
  }, []);

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
    // Re-measure every frame while open: a banner row, the phone nav or the
    // viewport can move the trigger without resizing it, so no resize event
    // fires and a one-shot cap goes stale and clips the last items.
    let raf = 0;
    const track = () => {
      layout();
      raf = requestAnimationFrame(track);
    };
    track();
    return () => {
      cancelAnimationFrame(raf);
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
          ref={attachPanel}
          id={menuId}
          className="ui-menu-panel ui-menu-popup"
          popover="manual"
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

/** Divides related item groups inside one `MenuSection`. */
export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />;
}
