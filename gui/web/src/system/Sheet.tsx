import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { BottomSheet, CloseButton, Dialog } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import type { SystemIconName } from "./icons";
import { SystemIcon } from "./SystemIcon";

export type SheetStep = {
  title: string;
  children: ReactNode;
  onBack: () => void;
};

export type SheetProps = {
  /**
   * `anchored` 320 and `side` 400 are static frames in the page; `centered`
   * wraps Dialog and `bottom` wraps BottomSheet (phone detents).
   */
  form: "anchored" | "side" | "centered" | "bottom";
  title: string;
  /** The object icon in the header. Static frames only. */
  icon?: SystemIconName;
  children: ReactNode;
  /** One primary, in the thumb zone. */
  footer?: ReactNode;
  /**
   * A pushed step replaces the body. In the static frames the header shows
   * Back and the step's title. Dialog and BottomSheet own their header, so
   * there the title changes and Back sits at the top of the body.
   */
  step?: SheetStep | null;
  onClose: () => void;
  /** Dialog and BottomSheet forms only. */
  open?: boolean;
  detent?: DrawerDetent;
  onDetentChange?: (detent: DrawerDetent) => void;
};

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      className="sys-icon-btn"
      aria-label="Back"
      title="Back"
      onClick={onBack}
    >
      <SystemIcon name="chevron-left" size={16} />
    </button>
  );
}

const FOCUSABLE = "button, input, select, textarea, a[href]";

function Body({
  step,
  backInBody,
  children,
  rowsRef,
}: Pick<SheetProps, "step" | "children"> & {
  backInBody: boolean;
  rowsRef: RefObject<HTMLDivElement | null>;
}) {
  if (!step) {
    return (
      <div ref={rowsRef} className="sys-sheet-rows">
        {children}
      </div>
    );
  }
  return (
    <div ref={rowsRef} className="sys-sheet-rows">
      {backInBody ? <BackButton onBack={step.onBack} /> : null}
      {step.children}
    </div>
  );
}

/** The Sheet frame: header 40, rows, optional footer. No Apply button: rows act as they change. */
export function Sheet({
  form,
  title,
  icon,
  children,
  footer,
  step,
  onClose,
  open = true,
  detent = "half",
  onDetentChange,
}: SheetProps) {
  const heading = step ? step.title : title;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const hadStep = useRef(false);
  const backInBody = form === "centered" || form === "bottom";
  const pushed = Boolean(step);
  // A push or a back replaces the body, so the focused control unmounts. Move
  // focus to the new step's heading (static frames) or its first control.
  useEffect(() => {
    if (hadStep.current === pushed) return;
    hadStep.current = pushed;
    if (!backInBody) {
      headingRef.current?.focus({ preventScroll: true });
      return;
    }
    const focusFirst = () =>
      rowsRef.current
        ?.querySelector<HTMLElement>(FOCUSABLE)
        ?.focus({ preventScroll: true });
    focusFirst();
    // The new title restarts the overlay hook, which moves focus to Close on
    // the next frame. Take it back after that, unless the user moved it.
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        !active ||
        active === document.body ||
        active.closest(".dialog-close, .bottom-sheet-header")
      ) {
        focusFirst();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pushed, backInBody]);
  const body = (
    <Body step={step} backInBody={backInBody} rowsRef={rowsRef}>
      {children}
    </Body>
  );
  if (form === "centered") {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={heading}
        panelClassName="sys-sheet-centered"
        footer={footer}
      >
        {body}
      </Dialog>
    );
  }
  if (form === "bottom") {
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        backgroundPolicy="interactive"
        title={heading}
        size={detent}
        drawer={{
          detents: ["peek", "half", "full"],
          detent,
          onDetentChange: (next) => onDetentChange?.(next),
          label: "Sheet height",
        }}
      >
        <div className="sys-sheet-bottom">
          <div className="sys-sheet-scroll">{body}</div>
          {footer ? <div className="sys-sheet-footer">{footer}</div> : null}
        </div>
      </BottomSheet>
    );
  }
  const Frame = form === "side" ? "aside" : "section";
  return (
    <Frame className={`sys-sheet sys-sheet--${form}`} aria-label={title}>
      <div className="sys-sheet-header">
        {step ? (
          <BackButton onBack={step.onBack} />
        ) : icon ? (
          <SystemIcon name={icon} size={16} />
        ) : null}
        <h2 ref={headingRef} tabIndex={-1} className="sys-sheet-title">
          {heading}
        </h2>
        <CloseButton onClick={onClose} />
      </div>
      <div className="sys-sheet-scroll">{body}</div>
      {footer ? <div className="sys-sheet-footer">{footer}</div> : null}
    </Frame>
  );
}
