import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { placeAnchored, tokenPx, visualViewportBox } from "./anchoredPlacement";
import { type DisabledReasonProps, unavailableReason } from "./disabledReason";
import { popoverSupported, showInTopLayer } from "./topLayerFloor";
import { useMenuKeyboard } from "./useMenuKeyboard";
import { useOutsidePointerDown } from "./useOutsidePointerDown";

function layoutOpenMenuPanel(trigger: HTMLElement, panel: HTMLElement): void {
  if (panel.dataset.menuMode === "fallback") {
    const rowSize = getComputedStyle(trigger).getPropertyValue(
      "--menu-item-min-block-size",
    );
    if (rowSize) {
      panel.style.setProperty("--menu-item-min-block-size", rowSize.trim());
    }
  }
  const ownerDocument = trigger.ownerDocument;
  const viewport = visualViewportBox(
    ownerDocument.querySelector(".stage-frame-tabs"),
  );
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
    Number.parseFloat(
      getComputedStyle(ownerDocument.documentElement).fontSize,
    ) || 16;
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
  ref: RefCallback<HTMLButtonElement>;
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const modeRef = useRef<"native" | "fallback" | null>(null);
  const [triggerNode, setTriggerNode] = useState<HTMLButtonElement | null>(
    null,
  );
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const attachTrigger = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (!modeRef.current) return;
    setTriggerNode(node);
    if (modeRef.current === "fallback") {
      setPortalTarget(node?.ownerDocument.body ?? null);
    }
  }, []);
  const mode = useMemo<"native" | "fallback" | null>(() => {
    if (!open) return null;
    return popoverSupported() ? "native" : "fallback";
  }, [open]);
  const attachPanel = useCallback(
    (panel: HTMLDivElement) => {
      if (!mode) return;
      setPanelNode(panel);
      const leave = mode === "native" ? showInTopLayer(panel) : null;
      return () => {
        leave?.();
        setPanelNode((current) => (current === panel ? null : current));
      };
    },
    [mode],
  );

  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  useLayoutEffect(() => {
    modeRef.current = mode;
    const node = mode ? triggerRef.current : null;
    setTriggerNode(node);
    setPortalTarget(
      mode === "fallback" ? (node?.ownerDocument.body ?? document.body) : null,
    );
  }, [mode]);

  useLayoutEffect(() => {
    if (!open || (mode === "fallback" && !portalTarget)) {
      return;
    }
    const layout = () => {
      const trigger = triggerNode;
      const panel = panelNode;
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
  }, [open, mode, portalTarget, triggerNode, panelNode]);

  useMenuKeyboard({
    open,
    panel: panelNode,
    close,
    fallbackTrigger: mode === "fallback" ? triggerNode : undefined,
  });

  useOutsidePointerDown({
    nodes: [panelNode, triggerNode],
    onOutside: close,
    enabled: open,
  });

  const panel =
    open && mode ? (
      <div
        ref={attachPanel}
        id={menuId}
        className="ui-menu-panel ui-menu-popup"
        data-menu-mode={mode}
        popover={mode === "native" ? "manual" : undefined}
        role="menu"
        aria-label={label}
        onMouseDown={(event) => {
          if (event.button !== 0 || !(event.target instanceof Element)) return;
          const item =
            event.target.closest<HTMLElement>('[role^="menuitem"]') ??
            event.target
              .closest("label")
              ?.querySelector<HTMLElement>('[role^="menuitem"]');
          if (!item || !event.currentTarget.contains(item)) return;
          event.preventDefault();
          item.focus({ preventScroll: true });
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            close();
          }
        }}
      >
        {children}
      </div>
    ) : null;

  return (
    <div
      className={className ?? "ui-menu-root"}
      onPointerDown={(event) => {
        if (
          open &&
          event.target instanceof Node &&
          triggerNode?.contains(event.target)
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
        ref: attachTrigger,
      })}
      {mode === "fallback" && panel
        ? portalTarget
          ? createPortal(panel, portalTarget)
          : null
        : panel}
    </div>
  );
}

type MenuItemProps = DisabledReasonProps & {
  children: ReactNode;
  onSelect?: () => void;
  className?: string;
  title?: string;
  /** Display-only shortcut, right-aligned; hidden from the accessible name. */
  shortcut?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** `aria-keyshortcuts` for the shortcut (the visible kbd is aria-hidden). */
  keyShortcuts?: string;
  /** A line under the label that says what the choice will act on. */
  description?: string;
  /** Extra description for assistive tech and the tooltip; draws nothing. */
  ariaDescription?: string;
  /** Trailing value, decorative: the label already carries it. */
  detail?: string;
  /**
   * One choice of several: the item becomes a `menuitemradio` and says whether
   * it is the chosen one. Leave it out for a plain action.
   */
  checked?: boolean;
  /** Marks the item a sliding finger is over (lift to pick it). */
  over?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** `data-*` hooks the caller's gesture router reads. */
  dataAttrs?: Readonly<Record<string, string>>;
};

/**
 * A menu choice. An item that cannot run stays focusable (`aria-disabled`),
 * says why under its label and does nothing on select, so the person who
 * reaches it by key or touch still learns what is missing.
 */
export function MenuItem({
  children,
  onSelect,
  className,
  title,
  disabledReason,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  shortcut,
  keyShortcuts,
  description,
  ariaDescription,
  detail,
  checked,
  over,
  onPointerDown,
  dataAttrs,
}: MenuItemProps) {
  const reasonId = useId();
  const noteId = useId();
  const reason = unavailableReason(disabledReason);
  const caption = reason ?? description;
  const classes = [
    "ui-control",
    "ui-control--quiet",
    over ? "is-over" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const label = <span className="ui-menu-item-label">{children}</span>;
  const body = caption ? (
    <span className="ui-menu-item-text">
      {label}
      <span id={reasonId} className="ui-menu-item-reason" aria-hidden="true">
        {caption}
      </span>
    </span>
  ) : shortcut || detail ? (
    label
  ) : (
    children
  );
  return (
    <>
      <button
        type="button"
        role={checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={checked}
        tabIndex={-1}
        className={classes}
        title={reason ?? title ?? ariaDescription}
        aria-keyshortcuts={keyShortcuts}
        aria-disabled={reason ? true : undefined}
        aria-describedby={
          caption ? reasonId : ariaDescription ? noteId : undefined
        }
        {...dataAttrs}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={() => {
          if (!reason) {
            onSelect?.();
          }
        }}
      >
        {body}
        {shortcut ? (
          <kbd className="ui-menu-shortcut" aria-hidden="true">
            {shortcut}
          </kbd>
        ) : null}
        {detail ? (
          <span className="ui-menu-detail" aria-hidden="true">
            {detail}
          </span>
        ) : null}
      </button>
      {ariaDescription ? (
        <span id={noteId} className="sr-only" aria-hidden="true">
          {ariaDescription}
        </span>
      ) : null}
    </>
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
  return <hr className="ui-menu-separator" />;
}
