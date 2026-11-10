import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../../system/imeKey";
import { SystemIcon } from "../../system/SystemIcon";
import { CloseButton } from "../../ui";
import type { AnchorExclusion } from "../../ui/useAnchoredPanel";
import { useAnchoredPanel } from "../../ui/useAnchoredPanel";
import { useTopLayerPanel } from "../../ui/useTopLayerPanel";
import { CommentThread } from "./CommentThread";

const FLOATING_BAR = ".sys-actions--floating";

export interface CommentPopoverAnchor {
  /** The comment's pin. */
  readonly ref: RefObject<HTMLElement | null>;
  readonly moves: readonly unknown[];
  readonly clearTop: () => number;
}

/**
 * The comment popover (spec-edit INS-COMMENT): the shared comment card in a
 * 320 px top-layer panel beside the pin. It stays mounted, hidden, while the
 * pin is off screen so a reply draft survives.
 */
export function CommentPopover({
  commentId,
  anchor,
  root,
  panelRef,
  away,
  onClose,
}: {
  commentId: string;
  anchor: CommentPopoverAnchor;
  root: HTMLElement | null;
  panelRef: RefObject<HTMLDivElement | null>;
  /** The pin is off screen. */
  away: boolean;
  onClose: () => void;
}) {
  const { ref: topLayerRef, popover } = useTopLayerPanel();
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      const detach = topLayerRef(el);
      return () => {
        panelRef.current = null;
        detach?.();
      };
    },
    [panelRef, topLayerRef],
  );
  const exclusion = useMemo<AnchorExclusion>(
    () => ({
      ref: {
        get current() {
          return root?.querySelector<HTMLElement>(FLOATING_BAR) ?? null;
        },
      },
      withinRef: { current: root },
    }),
    [root],
  );
  useAnchoredPanel(
    panelRef,
    {
      reason:
        "The comment stays beside its pin so the moment it is about stays in view.",
      ref: anchor.ref,
      exclusion,
      moves: anchor.moves,
      clearTop: anchor.clearTop,
    },
    true,
  );
  const focused = useRef(false);
  useEffect(() => {
    const panel = panelRef.current;
    if (away || focused.current || !panel) return;
    focused.current = true;
    (
      panel.querySelector<HTMLElement>("textarea") ??
      panel.querySelector<HTMLElement>(".dialog-close")
    )?.focus({ preventScroll: true });
  }, [away, panelRef]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event))
      return;
    event.stopPropagation();
    const field = event.target;
    if (field instanceof HTMLTextAreaElement && field.value.trim()) {
      panelRef.current
        ?.querySelector<HTMLElement>(".dialog-close")
        ?.focus({ preventScroll: true });
      return;
    }
    onClose();
  };
  return createPortal(
    <section
      ref={attach}
      popover={popover}
      className="sys-sheet sys-inspector sys-inspector--popover"
      role="dialog"
      aria-modal="false"
      aria-label="Comment"
      data-away={away || undefined}
    >
      <div
        role="presentation"
        className="sys-inspector-keys"
        onKeyDown={onKeyDown}
      >
        <div
          tabIndex={-1}
          className="sys-inspector-anchor"
          data-inspector-anchor
        />
        <div className="sys-sheet-header sys-inspector-header">
          <SystemIcon name="message-square" size={16} />
          <h2 className="sys-sheet-title">Comment</h2>
          <CloseButton onClick={onClose} />
        </div>
        <div className="sys-inspector-scroll">
          <CommentThread key={commentId} commentId={commentId} />
        </div>
      </div>
    </section>,
    document.body,
  );
}
