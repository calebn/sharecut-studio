import { useEffect, useMemo, useState } from "react";
import { saveSegment } from "../../api";
import { selectionAnchor } from "../../commands/timelineReveal";
import { segmentSavedMessage } from "../../edit/segmentSaveMessages";
import {
  type SegmentSelection,
  segmentSelectionOf,
} from "../../edit/segmentSelection";
import { useViewportClass } from "../../hooks/useViewportClass";
import { SaveSegmentCard } from "../../stages/edit/SaveSegmentCard";
import { useDawStore } from "../../state/dawStore";

export function SaveSegmentHost() {
  const open = useDawStore((s) => s.chrome.saveSegmentOpen);
  const project = useDawStore((s) => s.project);
  const selection = useDawStore((s) => s.selection);
  const projectPath = useDawStore((s) => s.projectPath);
  const setOpen = useDawStore((s) => s.setSaveSegmentOpen);
  const phone = useViewportClass() === "phone";
  const found = useMemo(
    () => (open ? segmentSelectionOf(project, selection) : null),
    [open, project, selection],
  );
  const anchorElement = useMemo(
    () => (open ? selectionAnchor.get() : null),
    [open],
  );
  const anchorRef = useMemo(
    () => ({ current: anchorElement }),
    [anchorElement],
  );
  const usable = found?.ok === true;
  const [frozen, setFrozen] = useState<{
    selection: SegmentSelection;
    projectPath: string;
  } | null>(null);
  if (!open && frozen) setFrozen(null);
  useEffect(() => {
    if (open && !usable && !frozen) setOpen(false);
  }, [open, usable, frozen, setOpen]);

  const shown = frozen?.selection ?? (found?.ok ? found : null);
  if (!open || !shown) return null;
  const onSave = async ({
    name,
    kind,
  }: {
    name: string;
    kind: Parameters<typeof saveSegment>[0]["kind"];
  }) => {
    const held = frozen ?? { selection: shown, projectPath };
    setFrozen(held);
    const result = await saveSegment({
      path: held.projectPath,
      name,
      kind,
      ...held.selection.request,
    });
    useDawStore.getState().announceStatus(segmentSavedMessage(name, result));
  };
  const common = {
    summary: shown.summary,
    defaultKind: shown.defaultKind,
    onSave,
    onClose: () => setOpen(false),
  };
  return phone || !anchorElement ? (
    <SaveSegmentCard {...common} form="bottom" open />
  ) : (
    <SaveSegmentCard {...common} anchorRef={anchorRef} />
  );
}
