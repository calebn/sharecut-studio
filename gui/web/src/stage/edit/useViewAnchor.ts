import { type RefObject, useLayoutEffect, useRef } from "react";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { subscribeModalOpen } from "../../ui/modalGate";

export type ViewAnchorAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; returnTarget: () => HTMLElement | null };

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
      pending.cancel();
      if (ownsFocus && isValidFocusTarget(destination)) destination.focus();
    } else {
      recovery.current?.cancel();
    }
  });

  useLayoutEffect(() => () => recovery.current?.cancel(), []);
}
