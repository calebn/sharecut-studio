import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import { opensFull, useCrampedSheet } from "../../stages/edit/useCrampedSheet";
import { Button, InlineError } from "../../ui";
import { Sheet } from "../Sheet";
import {
  ADDING_LABEL,
  CANCEL_LABEL,
  CHOOSE_AGAIN_LABEL,
  CLOSE_LABEL,
  checkingMessage,
} from "./importCopy";
import type { Staged, StagedImportState } from "./useStagedImport";

/** The two buttons a waiting file offers; `primary` is null when there is nothing to add. */
export type PreviewActions = { cancel: string; primary: string | null };

type Props<P extends Staged> = {
  state: StagedImportState<P>;
  title: string;
  onAdd: () => void;
  onCancel: () => void;
  onChooseAgain: () => void;
  /** The body for a waiting file, while it waits and while it is being added. */
  renderPreview: (preview: P, notice: string | null) => ReactNode;
  actions: (preview: P) => PreviewActions;
};

type FooterProps<P extends Staged> = Omit<
  Props<P>,
  "title" | "renderPreview"
> & {
  primaryRef: RefObject<HTMLButtonElement | null>;
};

function Footer<P extends Staged>({
  state,
  onAdd,
  onCancel,
  onChooseAgain,
  actions,
  primaryRef,
}: FooterProps<P>) {
  if (state.phase === "error") {
    return (
      <div className="sys-segment-actions">
        <Button onClick={onCancel}>{CLOSE_LABEL}</Button>
        <Button variant="primary" ref={primaryRef} onClick={onChooseAgain}>
          {CHOOSE_AGAIN_LABEL}
        </Button>
      </div>
    );
  }
  if (state.phase === "uploading" || state.phase === "idle") {
    return (
      <div className="sys-segment-actions">
        <Button onClick={onCancel}>{CANCEL_LABEL}</Button>
      </div>
    );
  }
  const committing = state.phase === "committing";
  const { cancel, primary } = actions(state.preview);
  if (primary === null) {
    return (
      <div className="sys-segment-actions">
        <Button variant="primary" ref={primaryRef} onClick={onCancel}>
          {cancel}
        </Button>
      </div>
    );
  }
  return (
    <div className="sys-segment-actions">
      <Button
        onClick={onCancel}
        disabledReason={committing ? "Adding to your library." : undefined}
      >
        {cancel}
      </Button>
      <Button
        variant="primary"
        ref={primaryRef}
        onClick={onAdd}
        disabledReason={committing ? ADDING_LABEL : undefined}
      >
        {committing ? ADDING_LABEL : primary}
      </Button>
    </div>
  );
}

/**
 * The sheet a staged import lives in: a bottom sheet on a phone and a centered card
 * elsewhere, the buttons pinned below the body except where the sheet is too short for
 * both. The kind of file only decides what the waiting body and its buttons say.
 */
export function ImportSheetFrame<P extends Staged>(props: Props<P>) {
  const { state, title, onCancel, renderPreview } = props;
  const primaryRef = useRef<HTMLButtonElement>(null);
  const phone = useViewportClass() === "phone";
  const cramped = useCrampedSheet();
  const pinned = !(phone && cramped);
  const footer = <Footer {...props} primaryRef={primaryRef} />;
  // The sheet opens while the file uploads, when there is no primary button yet; focus it
  // when the preview or the error arrives, and again when a retry brings Add back.
  const phase = state.phase;
  const before = useRef(phase);
  useEffect(() => {
    const was = before.current;
    before.current = phase;
    if (
      (phase === "preview" || phase === "error") &&
      (was === "uploading" || was === "committing")
    )
      primaryRef.current?.focus();
  }, [phase]);
  let body: ReactNode = null;
  if (state.phase === "uploading") {
    body = (
      <p className="segment-import-status" role="status">
        {checkingMessage(state.fileName)}
      </p>
    );
  } else if (state.phase === "preview") {
    body = renderPreview(state.preview, state.notice);
  } else if (state.phase === "committing") {
    body = renderPreview(state.preview, null);
  } else if (state.phase === "error") {
    body = (
      <>
        <p className="segment-import-file">{state.fileName}</p>
        <InlineError message={state.message} />
      </>
    );
  }
  return (
    <Sheet
      form={phone ? "bottom" : "centered"}
      open={state.phase !== "idle"}
      title={title}
      detent={phone && opensFull() ? "full" : "fit"}
      initialFocusRef={primaryRef}
      footer={pinned ? footer : undefined}
      onClose={onCancel}
    >
      <div className="segment-import">
        {body}
        {pinned ? null : footer}
      </div>
    </Sheet>
  );
}
