import type { ReactNode } from "react";
import type { CompactSheetProps } from "../stage/edit/useCompactInspector";
import type { SheetPlacement } from "../ui/BottomSheet";

/** On `.daw-shell` while the Inspector is a column beside the timeline (#1696). */
export const INSPECTOR_COLUMN_SHELL_CLASS = "daw-shell--inspector-column";

export type ShellAppearance = { guestShare: boolean; following: boolean };
export type ShellNotices = { banners: ReactNode; follow: ReactNode };
export type SheetPresentation = {
  open: boolean;
  /** `column`: in place on the inline end of the shell, not a bottom sheet. */
  placement: SheetPlacement;
  expanded: boolean;
  content: ReactNode;
  onClose: () => void;
  onExpandedChange: (expanded: boolean) => void;
  /** Extra class on the half sheet's panel; the inspector class by default. */
  className?: string;
  /** The compact inspector (peek strip) in place of the half sheet. */
  compact?: CompactSheetProps;
};
