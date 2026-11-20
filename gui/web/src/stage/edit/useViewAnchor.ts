import { type RefObject, useLayoutEffect, useRef } from "react";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { subscribeModalOpen } from "../../ui/modalGate";

export type ViewAnchorAvailability =
  | { kind: "available" }
  | {
      kind: "unavailable";
      returnTarget: () => HTMLElement | null;
      preferredTarget?: () => HTMLElement | null;
    };

export const AVAILABLE_VIEW_ANCHOR: ViewAnchorAvailability = {
  kind: "available",
};

export function useViewAnchor(
  open: boolean,
  availability: ViewAnchorAvailability,
  panelRef: RefObject<HTMLDivElement | null>,
  close: () => void,
) {
  const recovery = useRef<{
    owner: HTMLElement;
    destination: () => HTMLElement | null;
    preferred: (() => HTMLElement | null) | undefined;
    cancel: () => void;
  } | null>(null);

  useLayoutEffect(() => {
    if (open && availability.kind === "unavailable") {
      const panel = panelRef.current;
      const active = document.activeElement;
      if (
        !recovery.current &&
        active instanceof HTMLElement &&
        panel?.contains(active)
      ) {
        const cancel = () => {
          document.removeEventListener("focusin", cancel);
          document.removeEventListener("pointerdown", cancel, true);
          unsubscribe();
          recovery.current = null;
        };
        const unsubscribe = subscribeModalOpen(cancel);
        recovery.current = {
          owner: active,
          destination: availability.returnTarget,
          preferred: availability.preferredTarget,
          cancel,
        };
        document.addEventListener("focusin", cancel);
        document.addEventListener("pointerdown", cancel, true);
      }
      close();
    } else if (!open) {
      const pending = recovery.current;
      if (!pending) return;
      const active = document.activeElement;
      const ownsFocus =
        active === pending.owner ||
        (active === document.body && !pending.owner.isConnected);
      const destination = pending.destination();
      const preferred = pending.preferred;
      pending.cancel();
      if (ownsFocus && isValidFocusTarget(destination)) {
        destination.focus();
        if (preferred && destination !== preferred())
          upgradeFocus(destination, preferred);
      }
    } else {
      recovery.current?.cancel();
    }
  });

  useLayoutEffect(() => () => recovery.current?.cancel(), []);
}

const UPGRADE_WINDOW_MS = 5000;

function upgradeFocus(
  fallback: HTMLElement,
  preferred: () => HTMLElement | null,
) {
  const doc = fallback.ownerDocument;
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("pointerdown", stop, true);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== fallback) stop();
  };
  const observer = new MutationObserver(() => {
    const target = preferred();
    if (doc.activeElement !== fallback || !isValidFocusTarget(target)) return;
    stop();
    target.focus();
  });
  const timer = window.setTimeout(stop, UPGRADE_WINDOW_MS);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("pointerdown", stop, true);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });
}
