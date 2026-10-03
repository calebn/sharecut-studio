import type { ReactNode } from "react";

export type ShellAppearance = { guestShare: boolean; following: boolean };
export type ShellNotices = { banners: ReactNode; follow: ReactNode };
export type SheetPresentation = {
  open: boolean;
  expanded: boolean;
  content: ReactNode;
  onClose: () => void;
  onExpandedChange: (expanded: boolean) => void;
};
