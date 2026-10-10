import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { executePointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { HistoryEntryId } from "../types/project";
import { Toast } from "../ui";
import { errorMessage } from "../utils/apiError";
import { usePhoneToastDock } from "./toastDock";

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
  const focusRef = useRef<HTMLElement | null>(null);
  usePhoneToastDock(regionRef, toast != null && host == null);

  useLayoutEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) {
        focusRef.current = portal.contains(event.target) ? event.target : null;
      }
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [portal]);

  useLayoutEffect(() => {
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && portal.contains(active)
        ? active
        : active === document.body
          ? focusRef.current
          : null;
    (host ?? document.body).append(portal);
    focused?.focus({ preventScroll: true });
  }, [host, portal]);
  useLayoutEffect(() => () => portal.remove(), [portal]);
  const [visibility, setVisibility] = useState<"visible" | "clipped">(
    "visible",
  );
  useLayoutEffect(() => {
    const card = regionRef.current?.querySelector(".ui-toast");
    if (!host || !card) {
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
