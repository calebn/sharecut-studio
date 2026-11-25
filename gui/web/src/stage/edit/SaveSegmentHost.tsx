import { useEffect, useMemo, useRef } from "react";
import { saveSegment } from "../../api";
import { selectionAnchor } from "../../commands/timelineReveal";
import { segmentSavedMessage } from "../../edit/segmentSaveMessages";
import { segmentSelectionOf } from "../../edit/segmentSelection";
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
  const saving = useRef(false);
  const lastUsable = useRef<typeof found>(null);
  if (!open) lastUsable.current = null;
  else if (found?.ok) lastUsable.current = found;
  useEffect(() => {
    if (open && !usable && !saving.current) setOpen(false);
  }, [open, usable, setOpen]);

  const shown = found?.ok ? found : saving.current ? lastUsable.current : null;
  if (!open || !shown?.ok) return null;
  const onSave = async ({
    name,
    kind,
  }: {
    name: string;
    kind: Parameters<typeof saveSegment>[0]["kind"];
  }) => {
    saving.current = true;
    try {
      const result = await saveSegment({
        path: projectPath,
        name,
        kind,
        ...shown.request,
      });
      useDawStore.getState().announceStatus(segmentSavedMessage(name, result));
    } finally {
      saving.current = false;
    }
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
