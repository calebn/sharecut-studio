import type { ReactNode } from "react";
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
  icon?: SystemIconName;
  children: ReactNode;
  /** One primary, in the thumb zone. */
  footer?: ReactNode;
  /** A pushed step replaces the body and the header gets Back. */
  step?: SheetStep | null;
  onClose: () => void;
  /** Dialog and BottomSheet forms only. */
  open?: boolean;
  detent?: DrawerDetent;
  onDetentChange?: (detent: DrawerDetent) => void;
};

function Body({ step, children }: Pick<SheetProps, "step" | "children">) {
  if (!step) return <div className="sys-sheet-rows">{children}</div>;
  return (
    <div className="sys-sheet-rows">
      <button type="button" className="sys-text-btn" onClick={step.onBack}>
        Back
      </button>
      <h3 className="sys-sheet-step">{step.title}</h3>
      {step.children}
    </div>
  );
}

/** The Sheet frame: header 40, rows, optional footer. Values apply as they change. */
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
  const body = <Body step={step}>{children}</Body>;
  if (form === "centered") {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        title={title}
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
        title={title}
        size={detent}
        drawer={{
          detents: ["peek", "half", "full"],
          detent,
          onDetentChange: (next) => onDetentChange?.(next),
          label: "Sheet height",
        }}
      >
        {body}
        {footer ? <div className="sys-sheet-footer">{footer}</div> : null}
      </BottomSheet>
    );
  }
  const Frame = form === "side" ? "aside" : "section";
  return (
    <Frame className={`sys-sheet sys-sheet--${form}`} aria-label={title}>
      <div className="sys-sheet-header">
        {icon ? <SystemIcon name={icon} size={16} /> : null}
        <h2 className="sys-sheet-title">{title}</h2>
        <CloseButton onClick={onClose} />
      </div>
      <div className="sys-sheet-scroll">{body}</div>
      {footer ? <div className="sys-sheet-footer">{footer}</div> : null}
    </Frame>
  );
}
