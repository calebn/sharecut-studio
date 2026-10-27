import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useState,
} from "react";

type TipHandlers = {
  onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

type HoverTipState<T extends HTMLElement> = {
  open: boolean;
  id: string;
  /** The ref callback for the trigger the tip hangs over. */
  setAnchor: (element: T | null) => void;
  anchor: T | null;
  /** Spread on the element that wraps the trigger and the tip. The tip is a portal, which React still counts inside it, so moving onto the tip keeps it open. */
  handlers: TipHandlers;
};

/**
 * Hover and keyboard focus open a tip, Escape closes it until the pointer or
 * focus leaves, and touch never opens one: a tap selects, and the same facts
 * are in the accessible name.
 */
export function useHoverTip<T extends HTMLElement>(): HoverTipState<T> {
  const id = useId();
  const [anchor, setAnchor] = useState<T | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  return {
    open,
    id,
    setAnchor,
    anchor,
    handlers: {
      onPointerEnter: (event) => {
        if (event.pointerType !== "touch") setHovered(true);
      },
      onPointerLeave: () => {
        setHovered(false);
        setDismissed(false);
      },
      onFocus: (event) => {
        if (event.target.matches(":focus-visible")) setFocused(true);
      },
      onBlur: () => {
        setFocused(false);
        setDismissed(false);
      },
      onKeyDown: (event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setDismissed(true);
      },
    },
  };
}
