import { type ReactNode, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { HistoryPanel } from "../../panels/HistoryPanel";
import { useDawStore } from "../../state/dawStore";
import { Sheet } from "../../system/Sheet";
import type { StageSheet } from "../../types/stage";
import type { DrawerDetent } from "../../ui/BottomSheet";

const TITLES: Record<StageSheet, string> = {
  history: "History",
  view: "View",
  mix: "Mix",
};

/**
 * Renders the open Stage sheet: a bottom Sheet on a phone, a centered one
 * elsewhere. History is hosted here; the stage hosts hand in View and Mix.
 */
export function SheetHost({
  content,
}: {
  content?: Partial<Record<StageSheet, ReactNode>>;
}) {
  const { openSheet, setOpenSheet, shell } = useDawStore(
    useShallow((s) => ({
      openSheet: s.openSheet,
      setOpenSheet: s.setOpenSheet,
      shell: s.shellBreakpoint,
    })),
  );
  const [detent, setDetent] = useState<DrawerDetent>("half");
  if (!openSheet) return null;
  const body =
    content?.[openSheet] ?? (openSheet === "history" ? <HistoryPanel /> : null);
  if (!body) return null;
  return (
    <Sheet
      form={shell === "phone" ? "bottom" : "centered"}
      title={TITLES[openSheet]}
      detent={detent}
      onDetentChange={setDetent}
      onClose={() => setOpenSheet(null)}
    >
      {body}
    </Sheet>
  );
}
