import { type ReactNode, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { dispatchComposer } from "../../commands/composer";
import { HistoryPanel } from "../../panels/HistoryPanel";
import { useDawStore } from "../../state/dawStore";
import { Sheet } from "../../system/Sheet";
import type { StageSheet } from "../../types/stage";
import type { DrawerDetent } from "../../ui/BottomSheet";
import { useModalOpen } from "../../ui/useModalOpen";
import { ChaptersList } from "./ChaptersList";
import { InviteSheet } from "./InviteSheet";

const TITLES: Record<StageSheet, string> = {
  history: "History",
  mix: "Mix",
  tools: "Tools",
  invite: "Invite",
};

/**
 * Renders the open Stage sheet: a bottom Sheet on a phone, a centered one
 * elsewhere. History, Invite and Chapters (the composer session's surface, opened
 * from the Listen dock) are hosted here; the stage hosts hand in Mix and Tools.
 * The Comments sheet is the Listen layout's own (it needs the queue's state). The
 * phone's Mix sheet closes when a dialog opens over it.
 */
export function SheetHost({
  content,
}: {
  content?: Partial<Record<StageSheet, ReactNode>>;
}) {
  const { openSheet, setOpenSheet, shell, chaptersOpen } = useDawStore(
    useShallow((s) => ({
      openSheet: s.openSheet,
      setOpenSheet: s.setOpenSheet,
      shell: s.shellBreakpoint,
      chaptersOpen: s.composer.surface === "chapters",
    })),
  );
  const [detent, setDetent] = useState<DrawerDetent>("half");
  const modal = useModalOpen();
  // The phone's Mix sheet yields to any dialog that opens over it (Export
  // options, say) and does not come back when that dialog closes.
  const yieldsToDialog = openSheet === "mix" && shell === "phone" && modal;
  useEffect(() => {
    if (yieldsToDialog) setOpenSheet(null);
  }, [yieldsToDialog, setOpenSheet]);
  if (chaptersOpen) {
    const hide = () => dispatchComposer({ type: "show", surface: "none" });
    return (
      <Sheet
        form={shell === "phone" ? "bottom" : "centered"}
        title="Chapters"
        detent="fit"
        onClose={hide}
      >
        <ChaptersList onPicked={hide} />
      </Sheet>
    );
  }
  if (!openSheet || yieldsToDialog) return null;
  if (openSheet === "invite") {
    return (
      <InviteSheet
        form={shell === "phone" ? "bottom" : "centered"}
        detent={detent}
        onDetentChange={setDetent}
        onClose={() => setOpenSheet(null)}
      />
    );
  }
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
