import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { shallow } from "zustand/shallow";
import { executePointerCommand } from "../commands/pointer";
import {
  readyAfterSaveCopy,
  runsAfterSaveCopy,
  useWaitingMove,
} from "../commands/undoWait";
import { useDawStore } from "../state/dawStore";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "../state/documentSendOrder";
import type { ReverseAction } from "../state/types";
import { useDaw } from "../state/useDaw";
import type { HistoryEntryId } from "../types/project";
import { TOAST_MS, TOAST_UNDO_MS, Toast } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { registerFocusHold } from "../ui/focusHold";
import { isValidFocusTarget } from "../ui/focusTarget";
import { modalOpen } from "../ui/modalGate";
import { claimTopLayerFloor } from "../ui/topLayerFloor";
import { errorMessage } from "../utils/apiError";
import {
  FEEDBACK_FOCUS_ATTRIBUTE,
  hasValidFocusedFeedbackAction,
  isValidFeedbackAction,
} from "./feedbackActionFocus";
import { useToastDock } from "./toastDock";

/** Safari reports a fully shown card a hair under 1 at fractional zoom or toolbar heights. */
const VISIBLE_RATIO = 0.95;

const SHEET = '.bottom-sheet[role="dialog"]';

function currentSheetClose(host: HTMLElement | null): HTMLElement | null {
  if (modalOpen()) return null;
  const closes = host
    ? (host.closest(SHEET)?.querySelectorAll<HTMLElement>(".dialog-close") ??
      [])
    : document.querySelectorAll<HTMLElement>(`${SHEET} .dialog-close`);
  const close = [...closes].at(-1) ?? null;
  return isValidFocusTarget(close) ? close : null;
}

export function FeedbackToast({ host = null }: { host?: HTMLElement | null }) {
  const { toast, headId, projectPath } = useDaw((s) => ({
    toast: s.feedbackToast,
    headId: s.project?.history?.head_id ?? null,
    projectPath: s.projectPath,
  }));
  // An edit still on its way may make this toast's entry stale once it lands.
  // A press waits for it and runs only if the entry is still the newest step.
  const saving = useSyncExternalStore(subscribeDocumentActivity, () =>
    documentActivityBusy(projectPath),
  );
  const waiting = useWaitingMove(projectPath);
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
  useToastDock(regionRef, toast != null && host == null);
  const floating = toast != null && host == null;
  useLayoutEffect(() => {
    const region = regionRef.current;
    return floating && region ? claimTopLayerFloor(region) : undefined;
  }, [floating]);

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
        (state.remoteSelectionRevision === previous.remoteSelectionRevision &&
          !shallow(state.selection, previous.selection))
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
    if (!modalOpen() && isValidFeedbackAction(focused)) {
      focused.focus({ preventScroll: true });
      if (document.activeElement !== focused) {
        focused.removeAttribute(FEEDBACK_FOCUS_ATTRIBUTE);
        returnFocusRef.current = null;
        currentSheetClose(host)?.focus({ preventScroll: true });
      }
    }
  }, [host, portal]);
  useLayoutEffect(() => () => portal.remove(), [portal]);
  useLayoutEffect(() => registerFocusHold(hasValidFocusedFeedbackAction), []);
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
          entry?.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO
            ? "visible"
            : "clipped",
        );
      },
      { threshold: [0, VISIBLE_RATIO, 1] },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, [host, toast?.id]);
  const undoEntry =
    toast?.undo != null &&
    headId != null &&
    (toast.undo === headId || headId === toast.baseHead)
      ? toast.undo
      : null;

  useLayoutEffect(() => {
    const focused =
      remembered ??
      portal.querySelector<HTMLElement>(`[${FEEDBACK_FOCUS_ATTRIBUTE}]`);
    if (
      !portal.isConnected ||
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

  const toastReturn = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const target = toast?.returnFocus?.() ?? null;
    if (target) {
      toastReturn.current = target;
      returnFocusRef.current = target;
    } else if (toast && toastReturn.current) {
      if (returnFocusRef.current === toastReturn.current)
        returnFocusRef.current = null;
      toastReturn.current = null;
    }
  }, [toast]);

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
      useDawStore.getState().announceStatus(`Undo failed: ${errorMessage(e)}`, {
        tone: "error",
      });
    } finally {
      setUndoing(false);
    }
  };

  const reverse = async (
    { run, done }: ReverseAction,
    returnFocus: (() => HTMLElement | null) | null,
  ) => {
    setUndoing(true);
    try {
      if (await run()) {
        useDawStore.getState().announceStatus(done);
        const active = document.activeElement;
        if (!active || active === document.body || portal.contains(active))
          returnFocus?.()?.focus({ preventScroll: true });
      } else
        useDawStore
          .getState()
          .announceStatus(
            "Can't undo: the project changed since. Nothing was undone.",
            {
              tone: "error",
            },
          );
    } catch (e) {
      useDawStore.getState().announceStatus(`Undo failed: ${errorMessage(e)}`, {
        tone: "error",
      });
    } finally {
      setUndoing(false);
    }
  };

  const reversal = toast?.reverse ?? null;
  const onUndo =
    toast && undoEntry
      ? () => void undo(toast.message, undoEntry)
      : reversal
        ? () => void reverse(reversal, toast?.returnFocus ?? null)
        : undefined;

  return createPortal(
    <Toast
      className={
        host
          ? "ui-toast-region--app ui-toast-region--inspector-flow"
          : "ui-toast-region--app"
      }
      regionRef={regionRef}
      returnFocusRef={returnFocusRef}
      toast={toast}
      onDismiss={() => {
        if (!toast) return;
        const held = portal.contains(document.activeElement);
        useDawStore.getState().dismissFeedbackToast(toast.id);
        if (held) toast.returnFocus?.()?.focus({ preventScroll: true });
      }}
      onUndo={onUndo}
      undoDisabledReason={undoing ? BUSY_REASON : undefined}
      undoNote={
        waiting?.action === "undo" &&
        waiting.target !== null &&
        waiting.target === toast?.undo
          ? runsAfterSaveCopy("undo")
          : saving
            ? readyAfterSaveCopy("undo")
            : undefined
      }
      timeoutMs={onUndo ? TOAST_UNDO_MS : TOAST_MS}
      visibility={visibility}
    />,
    portal,
  );
}
