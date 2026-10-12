import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shallow } from "zustand/shallow";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { HistoryEntryId } from "../types/project";
import { Toast } from "../ui";
import { modalShortcuts } from "../ui/modalGate";
import { errorMessage } from "../utils/apiError";
import {
  FEEDBACK_FOCUS_ATTRIBUTE,
  isValidFeedbackAction,
  isValidFocusTarget,
} from "./feedbackActionFocus";
import { usePhoneToastDock } from "./toastDock";

function currentSheetClose(host: HTMLElement | null): HTMLElement | null {
  if (modalShortcuts() !== null) return null;
  const close =
    host
      ?.closest('.bottom-sheet[role="dialog"]')
      ?.querySelector<HTMLElement>(".dialog-close") ?? null;
  return isValidFocusTarget(close) ? close : null;
}

/**
 * The visible twin of `announceStatus`. The shell's polite live region already
 * speaks the same string, so this toast does not announce. Undo names the
 * history entry the change recorded and shows only while that entry is the
 * head this tab sees; the server refuses the undo (`history_stale`) if another
 * edit landed first, so Undo never reverses someone else's change.
 */
export function FeedbackToast({ host = null }: { host?: HTMLElement | null }) {
  const { toast, headId } = useDaw((s) => ({
    toast: s.feedbackToast,
    headId: s.project?.history?.head_id ?? null,
  }));
  const [undoing, setUndoing] = useState(false);
  const regionRef = useRef<HTMLDivElement>(null);
  const [portal] = useState(() => {
    const region = document.createElement("section");
    region.setAttribute("aria-label", "Status messages");
    return region;
  });
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const remembered = portal.querySelector<HTMLElement>(
    `[${FEEDBACK_FOCUS_ATTRIBUTE}]`,
  );
  usePhoneToastDock(regionRef, toast != null && host == null);

  useLayoutEffect(() => {
    const forgetFocus = () => {
      portal
        .querySelector(`[${FEEDBACK_FOCUS_ATTRIBUTE}]`)
        ?.removeAttribute(FEEDBACK_FOCUS_ATTRIBUTE);
      returnFocusRef.current = null;
    };
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        forgetFocus();
        if (
          portal.contains(event.target) &&
          isValidFeedbackAction(event.target)
        ) {
          event.target.setAttribute(FEEDBACK_FOCUS_ATTRIBUTE, "");
          returnFocusRef.current = currentSheetClose(portal.parentElement);
        }
      }
    };
    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !portal.contains(event.target))
        forgetFocus();
    };
    const unsubscribe = useDawStore.subscribe((state, previous) => {
      if (
        state.projectEpoch !== previous.projectEpoch ||
        state.projectPath !== previous.projectPath ||
        !shallow(state.selection, previous.selection)
      )
        forgetFocus();
    });
    document.addEventListener("focusin", rememberFocus);
    document.addEventListener("pointerdown", outsidePointer, true);
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("pointerdown", outsidePointer, true);
      unsubscribe();
    };
  }, [portal]);

  useLayoutEffect(() => {
    const focused = portal.querySelector<HTMLElement>(
      `[${FEEDBACK_FOCUS_ATTRIBUTE}]`,
    );
    (host ?? document.body).append(portal);
    returnFocusRef.current = focused ? currentSheetClose(host) : null;
    if (modalShortcuts() === null && isValidFeedbackAction(focused)) {
      focused.focus({ preventScroll: true });
      if (document.activeElement !== focused) {
        focused.removeAttribute(FEEDBACK_FOCUS_ATTRIBUTE);
        returnFocusRef.current = null;
        currentSheetClose(host)?.focus({ preventScroll: true });
      }
    }
  }, [host, portal]);
  useLayoutEffect(() => () => portal.remove(), [portal]);
  const [visibility, setVisibility] = useState<"visible" | "clipped">(
    "visible",
  );
  useLayoutEffect(() => {
    const card = regionRef.current?.querySelector(".ui-toast");
    if (!card) {
      setVisibility("visible");
      return;
    }
    setVisibility("clipped");
    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisibility(
          entry?.isIntersecting && entry.intersectionRatio === 1
            ? "visible"
            : "clipped",
        );
      },
      { threshold: [0, 1] },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [host, toast?.id]);
  const undoEntry =
    toast?.undo != null && toast.undo === headId ? toast.undo : null;

  useLayoutEffect(() => {
    const focused =
      remembered ??
      portal.querySelector<HTMLElement>(`[${FEEDBACK_FOCUS_ATTRIBUTE}]`);
    if (
      !focused?.hasAttribute(FEEDBACK_FOCUS_ATTRIBUTE) ||
      isValidFeedbackAction(focused)
    )
      return;
    focused.removeAttribute(FEEDBACK_FOCUS_ATTRIBUTE);
    const target = currentSheetClose(host);
    returnFocusRef.current = null;
    const active = document.activeElement;
    if (
      isValidFocusTarget(target) &&
      (active === focused || active === document.body)
    )
      target.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (toast?.undo && undoEntry == null) {
      useDawStore.getState().dropFeedbackUndo(toast.id);
    }
  }, [toast, undoEntry]);

  const undo = async (message: string, expectedHeadId: HistoryEntryId) => {
    setUndoing(true);
    try {
      const result = await executePointerCommand("history.undo", {
        expectedHeadId,
      });
      if (result.status === "ok") {
        useDawStore.getState().announceStatus(`Undone: ${message}`);
      }
    } catch (e) {
      useDawStore.getState().announceStatus(`Undo failed: ${errorMessage(e)}`);
    } finally {
      setUndoing(false);
    }
  };

  return createPortal(
    <Toast
      announce={false}
      className={
        host
          ? "ui-toast-region--app ui-toast-region--inspector-flow"
          : "ui-toast-region--app"
      }
      regionRef={regionRef}
      returnFocusRef={returnFocusRef}
      toast={toast}
      onDismiss={() => {
        if (toast) useDawStore.getState().dismissFeedbackToast(toast.id);
      }}
      onUndo={
        toast && undoEntry
          ? () => void undo(toast.message, undoEntry)
          : undefined
      }
      undoDisabled={undoing}
      visibility={visibility}
    />,
    portal,
  );
}
