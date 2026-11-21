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
import type { ReverseAction } from "../state/types";
import { useDaw } from "../state/useDaw";
import { useDocumentBusy } from "../state/useDocumentBusy";
import type { HistoryEntryId } from "../types/project";
import { Toast } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { registerFocusHold } from "../ui/focusHold";
import { isValidFocusTarget } from "../ui/focusTarget";
import {
  innermostModalPanel,
  modalOpen,
  subscribeModalOpen,
} from "../ui/modalGate";
import { claimTopLayerFloor } from "../ui/topLayerFloor";
import { errorMessage, isPermanentRejection } from "../utils/apiError";
import { plainError } from "../utils/plainError";
import {
  FEEDBACK_FOCUS_ATTRIBUTE,
  hasValidFocusedFeedbackAction,
  isValidFeedbackAction,
} from "./feedbackActionFocus";
import { useToastDock } from "./toastDock";

/** Safari reports a fully shown card a hair under 1 at fractional zoom or toolbar heights. */
const VISIBLE_RATIO = 0.95;

const SHEET =
  ':is(.bottom-sheet[role="dialog"], .sys-inspector[role="dialog"])';

function currentSheetClose(host: HTMLElement | null): HTMLElement | null {
  if (modalOpen()) return null;
  const closes = host
    ? (host.closest(SHEET)?.querySelectorAll<HTMLElement>(".dialog-close") ??
      [])
    : document.querySelectorAll<HTMLElement>(`${SHEET} .dialog-close`);
  const close = [...closes].at(-1) ?? null;
  return isValidFocusTarget(close) ? close : null;
}

function restoreOrigin(target: HTMLElement | null): HTMLElement | null {
  if (!isValidFocusTarget(target)) return null;
  return !modalOpen() || innermostModalPanel()?.contains(target)
    ? target
    : null;
}

export function FeedbackToast({ host = null }: { host?: HTMLElement | null }) {
  const { toast, headId, projectPath } = useDaw((s) => ({
    toast: s.feedbackToast,
    headId: s.project?.history?.head_id ?? null,
    projectPath: s.projectPath,
  }));
  // An edit still on its way may make this toast's entry stale once it lands.
  // A press waits for it and runs only if the entry is still the newest step.
  const saving = useDocumentBusy(projectPath);
  const waiting = useWaitingMove(projectPath);
  const [undoing, setUndoing] = useState(false);
  const [acting, setActing] = useState(false);
  const reversing = useRef<ReverseAction | null>(null);
  const [reversingId, setReversingId] = useState<number | null>(null);
  const [retry, setRetry] = useState<{ id: number; message: string } | null>(
    null,
  );
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
  const modal = useSyncExternalStore(subscribeModalOpen, modalOpen);
  const modalPanel = useSyncExternalStore(
    subscribeModalOpen,
    innermostModalPanel,
  );
  const share = toast?.reverse?.share;
  const origin = share ? (toast?.returnFocus?.() ?? null) : null;
  const modalActionOrigin =
    origin?.isConnected && modalPanel?.contains(origin) ? origin.id : undefined;
  useToastDock(regionRef, toast != null && host == null);
  const covered = modal && !modalActionOrigin;
  const floating = toast != null && host == null && !covered;
  useLayoutEffect(() => {
    portal.inert = covered;
  }, [covered, portal]);
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
          const toast = useDawStore.getState().feedbackToast;
          returnFocusRef.current =
            (toast?.reverse?.share
              ? restoreOrigin(toast.returnFocus?.() ?? null)
              : null) ?? currentSheetClose(portal.parentElement);
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
    (toast.undo === headId ||
      headId === toast.baseHead ||
      toast.merged?.entries.includes(headId))
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
    const target = restoreOrigin(origin) ?? currentSheetClose(host);
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
    const target = restoreOrigin(toast?.returnFocus?.() ?? null);
    if (target) {
      toastReturn.current = target;
      returnFocusRef.current = target;
    } else if (toast && toastReturn.current) {
      if (returnFocusRef.current === toastReturn.current)
        returnFocusRef.current = null;
      toastReturn.current = null;
    }
  }, [toast, modal, modalPanel]);

  useEffect(() => {
    if (toast?.undo && undoEntry == null) {
      useDawStore.getState().dropFeedbackUndo(toast.id);
    }
  }, [toast, undoEntry]);

  const undo = async (
    message: string,
    entries: readonly HistoryEntryId[],
    onUndone: (() => void) | undefined,
  ) => {
    setUndoing(true);
    let undone = 0;
    try {
      for (const expectedHeadId of entries) {
        const result = await executePointerCommand("history.undo", {
          expectedHeadId,
        });
        if (result.status !== "ok") break;
        undone += 1;
      }
      if (undone === entries.length) {
        useDawStore.getState().announceStatus(`Undone: ${message}`);
        onUndone?.();
      } else if (undone > 0) {
        useDawStore
          .getState()
          .announceStatus(
            `Undid ${undone} of ${entries.length}. Can't undo the rest: the project changed since.`,
            { tone: "error" },
          );
      }
    } catch (e) {
      useDawStore
        .getState()
        .announceStatus(
          `Undo failed${undone > 0 ? ` after ${undone} of ${entries.length}` : ""}: ${errorMessage(e)}`,
          { tone: "error" },
        );
    } finally {
      setUndoing(false);
    }
  };

  const reverse = async (
    action: ReverseAction,
    id: number,
    returnFocus: (() => HTMLElement | null) | null,
  ) => {
    const { run, done, share } = action;
    const isCurrent = () => {
      const state = useDawStore.getState();
      return (
        state.feedbackToast?.id === id &&
        (!share ||
          (share.projectPath === state.projectPath &&
            share.projectEpoch === state.projectEpoch))
      );
    };
    if (reversing.current || !isCurrent()) return;
    const focusOrigin = () => {
      const active = document.activeElement;
      if (!active || active === document.body || portal.contains(active))
        restoreOrigin(returnFocus?.() ?? null)?.focus({ preventScroll: true });
    };
    if (share && share.deadline <= Date.now()) {
      focusOrigin();
      useDawStore
        .getState()
        .announceStatus("Too late to undo.", { tone: "error" });
      return;
    }
    reversing.current = action;
    setReversingId(id);
    setRetry(null);
    try {
      const outcome = await run();
      if (share && !isCurrent()) return;
      focusOrigin();
      if (outcome === true) {
        useDawStore.getState().announceStatus(done);
      } else {
        useDawStore
          .getState()
          .announceStatus(
            outcome === false
              ? "Can't undo: the project changed since. Nothing was undone."
              : outcome,
            { tone: "error" },
          );
      }
    } catch (e) {
      if (share && !isCurrent()) return;
      const message = `Undo failed: ${errorMessage(e)}`;
      if (share && Date.now() < share.deadline && !isPermanentRejection(e)) {
        setRetry({ id, message: plainError(message) });
        useDawStore
          .getState()
          .announceStatus(message, { tone: "error", toast: false });
        const active = document.activeElement;
        if (!active || active === document.body)
          restoreOrigin(returnFocus?.() ?? null)?.focus({
            preventScroll: true,
          });
      } else {
        focusOrigin();
        useDawStore.getState().announceStatus(message, { tone: "error" });
      }
    } finally {
      reversing.current = null;
      setReversingId(null);
    }
  };

  const act = async (run: () => void | Promise<void>) => {
    setActing(true);
    try {
      await run();
    } finally {
      setActing(false);
    }
  };

  const reversal = toast?.reverse ?? null;
  const shareRetry =
    share && retry?.id === toast?.id ? retry?.message : undefined;
  const onUndo =
    toast && undoEntry
      ? () => {
          if (undoing) return;
          void undo(
            toast.message,
            toast.merged?.entries ?? [undoEntry],
            toast.onUndone,
          );
        }
      : toast && reversal
        ? () => void reverse(reversal, toast.id, toast.returnFocus)
        : undefined;

  const runnableAction =
    toast?.action && (undoEntry != null || toast.undo == null)
      ? toast.action
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
        if (held)
          restoreOrigin(toast.returnFocus?.() ?? null)?.focus({
            preventScroll: true,
          });
      }}
      onUndo={onUndo}
      timeoutMs={toast?.dwellMs ?? undefined}
      expiresAtMs={reversingId === toast?.id ? undefined : share?.deadline}
      modalActionOrigin={modalActionOrigin || undefined}
      undoLabel={toast?.merged ? "Undo all" : undefined}
      actionLabel={toast?.action?.label}
      onAction={runnableAction ? () => void act(runnableAction.run) : undefined}
      actionDisabledReason={acting ? BUSY_REASON : undefined}
      undoDisabledReason={
        undoing || reversingId !== null ? BUSY_REASON : undefined
      }
      undoNote={
        share
          ? shareRetry
          : waiting?.action === "undo" &&
              waiting.target !== null &&
              waiting.target === toast?.undo
            ? runsAfterSaveCopy("undo")
            : saving
              ? readyAfterSaveCopy("undo")
              : undefined
      }
      visibility={visibility}
    />,
    portal,
  );
}
