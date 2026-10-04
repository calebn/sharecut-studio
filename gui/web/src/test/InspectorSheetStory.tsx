import { type ReactNode, useLayoutEffect, useState } from "react";
import { BottomSheet } from "../ui/BottomSheet";

export function InspectorSheetStory({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const fontSize = root.style.fontSize;
    const shell = root.dataset.shell;
    root.style.fontSize = "200%";
    root.dataset.shell = "phone";
    return () => {
      root.style.fontSize = fontSize;
      if (shell === undefined) delete root.dataset.shell;
      else root.dataset.shell = shell;
    };
  }, []);
  return (
    <BottomSheet
      open={open}
      onClose={() => setOpen(false)}
      backgroundPolicy="interactive"
      title="Inspector"
      expanded={expanded}
      onExpandedChange={setExpanded}
    >
      {children}
    </BottomSheet>
  );
}
