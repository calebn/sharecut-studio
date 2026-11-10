import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useMemo,
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
 * 320 px panel in the top layer beside the pin. It keeps clear of the floating
 * Action bar and hides, as the bar does, while the chrome above the lanes would
 * cover it. Escape and Close are the host's `onClose`.
 */
export function CommentPopover({
  commentId,
  anchor,
  root,
  panelRef,
  onClose,
}: {
  commentId: string;
  anchor: CommentPopoverAnchor;
  root: HTMLElement | null;
  panelRef: RefObject<HTMLDivElement | null>;
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
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || isImeKey(event))
      return;
    event.stopPropagation();
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
