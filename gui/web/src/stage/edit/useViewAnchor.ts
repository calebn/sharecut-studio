import { type RefObject, useLayoutEffect, useRef } from "react";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { modalOpen, subscribeModalOpen } from "../../ui/modalGate";

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
  const upgrade = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (availability.kind === "available") {
      upgrade.current?.();
      upgrade.current = null;
    }
    if (open && availability.kind === "unavailable") {
      upgrade.current?.();
      upgrade.current = null;
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
        upgrade.current?.();
        upgrade.current =
          preferred && destination !== preferred()
            ? upgradeFocus(destination, preferred)
            : null;
      }
    } else {
      recovery.current?.cancel();
      upgrade.current?.();
      upgrade.current = null;
    }
  });

  useLayoutEffect(
    () => () => {
      recovery.current?.cancel();
      upgrade.current?.();
    },
    [],
  );
}

const UPGRADE_WINDOW_MS = 5000;

function upgradeFocus(
  fallback: HTMLElement,
  preferred: () => HTMLElement | null,
): () => void {
  const doc = fallback.ownerDocument;
  const stop = () => {
    observer.disconnect();
    unsubscribe();
    window.clearTimeout(timer);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("pointerdown", stop, true);
    doc.removeEventListener("keydown", stop, true);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== fallback) stop();
  };
  const observer = new MutationObserver(() => {
    const target = preferred();
    if (modalOpen()) {
      stop();
      return;
    }
    if (doc.activeElement !== fallback || !isValidFocusTarget(target)) return;
    stop();
    target.focus();
  });
  const timer = window.setTimeout(stop, UPGRADE_WINDOW_MS);
  const unsubscribe = subscribeModalOpen(stop);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("pointerdown", stop, true);
  doc.addEventListener("keydown", stop, true);
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "class"],
  });
  return stop;
}
