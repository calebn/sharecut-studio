import type { ReactNode, RefObject } from "react";
import { Sheet } from "../../system/Sheet";
import { Dialog } from "../../ui";

export type SegmentCardFrameProps = {
  title: string;
  open: boolean;
  busy: RefObject<boolean>;
  onClose: () => void;
  initialFocusRef: RefObject<HTMLElement | null>;
  children: ReactNode;
} & (
  | { form?: "anchored"; anchorRef: RefObject<HTMLElement | null> }
  | { form: "bottom"; anchorRef?: undefined }
);

export function SegmentCardFrame(props: SegmentCardFrameProps) {
  const { title, open, busy, initialFocusRef, children } = props;
  const onClose = () => {
    if (!busy.current) props.onClose();
  };
  if (props.form === "bottom") {
    return (
      <Sheet form="bottom" title={title} open={open} onClose={onClose}>
        {children}
      </Sheet>
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      panelClassName="sys-segment-panel"
      initialFocusRef={initialFocusRef}
      anchor={{
        reason:
          "the card opens beside the selection or Action bar it works on, so the clips and the playhead stay in view",
        ref: props.anchorRef,
      }}
    >
      {children}
    </Dialog>
  );
}
