import type { ReactNode } from "react";
import type { CompactSheetProps } from "./useCompactInspector";

export type ShellAppearance = { guestShare: boolean; following: boolean };
export type ShellNotices = { banners: ReactNode; follow: ReactNode };
export type SheetPresentation = {
  open: boolean;
  expanded: boolean;
  content: ReactNode;
  onClose: () => void;
  onExpandedChange: (expanded: boolean) => void;
  /** The compact inspector (peek strip) in place of the half sheet. */
  compact?: CompactSheetProps;
};
