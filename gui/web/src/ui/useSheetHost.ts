import { useState } from "react";
import { focusAndReveal } from "./focusAndReveal";
import { registerFocusHold } from "./focusHold";

const SHELL_SELECTOR = ".stage-frame";
const ROOT_CLASS = "bottom-sheet-root";
const COLUMN_CLASS = "bottom-sheet-column-host";

type TextField = HTMLInputElement | HTMLTextAreaElement;

function caret(field: TextField): [number, number] | null {
  try {
    const { selectionStart: start, selectionEnd: end } = field;
    return start === null || end === null ? null : [start, end];
  } catch {
    return null; // number and date inputs have no selection
  }
}

function keepFocus(host: HTMLElement, move: () => void): void {
  const active = host.ownerDocument.activeElement;
  const field =
    active instanceof HTMLElement && host.contains(active) ? active : null;
  const text =
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field
      : null;
  const range = text ? caret(text) : null;
  const body = host.querySelector<HTMLElement>(".bottom-sheet-body");
  const scrollTop = body?.scrollTop ?? 0;
  move();
  // A move resets the body's scroll offset.
  if (body && body.scrollTop !== scrollTop) body.scrollTop = scrollTop;
  if (!field) return;
  if (field.ownerDocument.activeElement !== field) {
    field.focus({ preventScroll: true });
    if (text && range) {
      try {
        text.setSelectionRange(...range);
      } catch {
        // The field changed type while it moved.
      }
    }
  }
  // The sheet's focusin listener is still the previous placement's, so the
  // refocus does not reveal the field itself.
  focusAndReveal(field);
  // The sheet takes entry focus on the frame after a placement change.
  const release = registerFocusHold((doc) => doc.activeElement === field);
  const win = field.ownerDocument.defaultView;
  if (win) win.requestAnimationFrame(() => win.requestAnimationFrame(release));
  else release();
}

export type SheetHost = {
  readonly container: HTMLDivElement;
  place: (column: boolean, stowed: boolean) => void;
  detach: () => void;
};

export function createSheetHost(doc: Document): SheetHost {
  const container = doc.createElement("div");
  return {
    container,
    place(column: boolean, stowed: boolean): void {
      const shell = column ? doc.querySelector(SHELL_SELECTOR) : null;
      const slot = shell?.querySelector(":scope > main") ?? null;
      container.className = column
        ? COLUMN_CLASS
        : `${ROOT_CLASS}${stowed ? " is-stowed" : ""}`;
      if (column) container.removeAttribute("role");
      else container.setAttribute("role", "presentation");
      container.toggleAttribute("inert", !column && stowed);
      const active = doc.activeElement;
      if (
        container.hasAttribute("inert") &&
        active &&
        container.contains(active)
      ) {
        (active as HTMLElement).blur();
      }
      const placed = slot
        ? container.previousElementSibling === slot
        : container.parentElement === doc.body;
      if (placed) return;
      keepFocus(container, () => {
        if (slot) slot.after(container);
        else doc.body.append(container);
      });
    },
    detach(): void {
      container.remove();
    },
  };
}

/**
 * Owns the stable DOM container a BottomSheet portals into. The
 * sheet lives under `<body>` with its scrim; the Inspector column lives in the
 * shell's grid (#1696). Portaling into a container that changes would unmount
 * the subtree and lose its drafts and focus when the phone turns, so the
 * container stays and its parent switches instead.
 */
export function useSheetHost(): SheetHost | null {
  const [host] = useState(() =>
    typeof document === "undefined" ? null : createSheetHost(document),
  );
  return host;
}
