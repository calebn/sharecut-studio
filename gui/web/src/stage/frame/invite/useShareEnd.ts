import { type RefCallback, useEffect, useRef, useState } from "react";
import {
  type ShareEnd,
  type ShareOptions,
  shareEndKey,
} from "../../../stages/deliver/shareLogic";
import { cancelInlineConfirm } from "../../../ui/inlineConfirmGate";

/**
 * The one link or room whose end the person is confirming in place. Escape
 * keeps it, as Keep does; confirming hands the end to the flow.
 */
export function useShareEnd(
  options: Pick<ShareOptions, "onStop" | "onEndRoom">,
) {
  const [pending, setPending] = useState<ShareEnd | null>(null);
  const refocusKey = useRef<string | null>(null);
  const asking = pending !== null;
  useEffect(() => {
    if (!asking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cancelInlineConfirm()) event.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [asking]);
  const keep = () => {
    refocusKey.current = pending ? shareEndKey(pending) : null;
    setPending(null);
  };
  /** Ref for the control that asked: it takes focus back when the person keeps the link. */
  const trigger =
    (target: ShareEnd): RefCallback<HTMLElement> =>
    (el) => {
      if (el && refocusKey.current === shareEndKey(target)) {
        refocusKey.current = null;
        el.focus();
      }
    };
  /** Returns true when something was ended, so the caller can move focus. */
  const confirm = (): boolean => {
    if (!pending) return false;
    setPending(null);
    if (pending.kind === "link") options.onStop(pending.token);
    else options.onEndRoom(pending.sessionId);
    return true;
  };
  return { pending, ask: setPending, keep, confirm, trigger };
}
