import type { RefCallback } from "react";
import { BottomSheet } from "../../ui/BottomSheet";
import { INSPECTOR_SHEET_CLASS } from "../../ui/compactSheet";
import type { SelectionSheet } from "./useSelectionSheet";

/** The selection Inspector as a bottom sheet (phone and tablet), or a column when held sideways. */
export function InspectorSheet({
  sheet,
  feedbackHostRef,
}: {
  sheet: SelectionSheet;
  feedbackHostRef?: RefCallback<HTMLDivElement>;
}) {
  return (
    <BottomSheet
      backgroundPolicy="interactive"
      open={sheet.open}
      onClose={sheet.onClose}
      title="Inspector"
      placement={sheet.placement}
      className={sheet.className ?? INSPECTOR_SHEET_CLASS}
      expanded={sheet.expanded}
      stowed={sheet.stowed}
      onExpandedChange={sheet.onExpandedChange}
      {...sheet.compact}
      bodyHeader={
        sheet.compact && !sheet.compact.stowed ? (
          <div ref={feedbackHostRef} className="compact-feedback-slot" />
        ) : null
      }
    >
      {sheet.content}
    </BottomSheet>
  );
}
