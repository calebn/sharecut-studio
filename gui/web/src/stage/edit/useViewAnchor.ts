import { type RefObject, useLayoutEffect, useRef } from "react";
import { isValidFocusTarget } from "../../ui/focusTarget";
import { modalOpen, subscribeModalOpen } from "../../ui/modalGate";

export type ViewFocusTarget = {
  get: () => HTMLElement | null;
  subscribe: (listener: () => void) => () => void;
};

export type ViewAnchorAvailability =
  | { kind: "available" }
  | {
      kind: "unavailable";
      returnTarget: () => HTMLElement | null;
      preferredTarget?: ViewFocusTarget;
      awaitingTarget?: boolean;
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
    preferred: ViewFocusTarget | undefined;
    cancel: () => void;
  } | null>(null);
  const handoff = useRef<ReturnType<typeof waitForTarget> | null>(null);

  useLayoutEffect(() => {
    const preferred =
      availability.kind === "unavailable"
        ? availability.preferredTarget
        : undefined;
    const awaiting =
      availability.kind === "unavailable" && availability.awaitingTarget;
    const waiting = handoff.current;
    if (waiting) {
      if (open || waiting.target !== preferred) waiting.cancel();
      else if (!awaiting) waiting.settle();
    }

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
          preferred,
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
      pending.cancel();
      if (
        !ownsFocus ||
        modalOpen() ||
        (pending.preferred && pending.preferred !== preferred)
      )
        return;

      const target = pending.preferred?.get() ?? null;
      if (isValidFocusTarget(target)) {
        target.focus();
        return;
      }
      const fallback = pending.destination();
      if (!isValidFocusTarget(fallback)) return;
      fallback.focus();
      if (
        awaiting &&
        pending.preferred &&
        fallback === document.activeElement &&
        !modalOpen()
      ) {
        handoff.current = waitForTarget(fallback, pending.preferred, () => {
          handoff.current = null;
        });
      }
    } else {
      recovery.current?.cancel();
    }
  });

  useLayoutEffect(
    () => () => {
      recovery.current?.cancel();
      handoff.current?.cancel();
    },
    [],
  );
}

function waitForTarget(
  fallback: HTMLElement,
  target: ViewFocusTarget,
  clear: () => void,
) {
  const doc = fallback.ownerDocument;
  const view = doc.defaultView;
  let frame: number | null = null;
  let settled = false;

  const cancel = () => {
    if (frame !== null) view?.cancelAnimationFrame(frame);
    unsubscribeTarget();
    unsubscribeModal();
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("pointerdown", cancel, true);
    doc.removeEventListener("keydown", cancel, true);
    clear();
  };
  const onFocus = (event: FocusEvent) => {
    if (event.target !== fallback) cancel();
  };
  const check = () => {
    if (frame !== null || view === null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (modalOpen() || doc.activeElement !== fallback) {
        cancel();
        return;
      }
      const next = target.get();
      if (isValidFocusTarget(next)) {
        cancel();
        next.focus();
      } else if (settled) {
        cancel();
      }
    });
  };
  const unsubscribeTarget = target.subscribe(check);
  const unsubscribeModal = subscribeModalOpen(cancel);
  doc.addEventListener("focusin", onFocus);
  doc.addEventListener("pointerdown", cancel, true);
  doc.addEventListener("keydown", cancel, true);
  if (target.get()) check();

  return {
    target,
    cancel,
    settle: () => {
      settled = true;
      check();
    },
  };
}
