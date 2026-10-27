import { useLayoutEffect } from "react";
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

/**
 * Places the host and sets what it is: the sheet's `.bottom-sheet-root` on
 * `<body>`, or a box-less parent in the shell's grid, right after `<main>`
 * (inert while a sheet is stowed). It renders first inside the portal, so the
 * host is in the document before the sheet's own layout effects run. A move
 * blurs whatever the browser had focused inside, so focus returns to it, the body keeps its scroll offset, and the field is
 * revealed.
 */
export function SheetHostPlacement({
  host,
  column,
  stowed,
}: {
  host: HTMLElement;
  column: boolean;
  stowed: boolean;
}) {
  useLayoutEffect(() => {
    const doc = host.ownerDocument;
    const shell = column ? doc.querySelector(SHELL_SELECTOR) : null;
    const slot = shell?.querySelector(":scope > main") ?? null;
    host.className = column
      ? COLUMN_CLASS
      : `${ROOT_CLASS}${stowed ? " is-stowed" : ""}`;
    if (column) host.removeAttribute("role");
    else host.setAttribute("role", "presentation");
    host.toggleAttribute("inert", !column && stowed);
    const placed = slot
      ? host.previousElementSibling === slot
      : host.parentElement === doc.body;
    if (placed) return;
    keepFocus(host, () => {
      if (slot) slot.after(host);
      else doc.body.append(host);
    });
  }, [host, column, stowed]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return null;
}
