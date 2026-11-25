import { useEffect } from "react";
import { useViewportClass } from "../hooks/useViewportClass";
import { Sheet } from "../system/Sheet";
import { stopAudition } from "./audition";
import { LIBRARY_LABEL, SegmentLibraryBody } from "./SegmentLibraryBody";
import {
  type SegmentLibraryState,
  useSegmentLibrary,
} from "./useSegmentLibrary";

type ViewProps = {
  open: boolean;
  onClose: () => void;
  library: SegmentLibraryState;
};

export function SegmentLibrarySheetView({ open, onClose, library }: ViewProps) {
  const phone = useViewportClass() === "phone";
  useEffect(() => {
    if (!open) stopAudition();
  }, [open]);
  return (
    <Sheet
      form={phone ? "bottom" : "end"}
      open={open}
      onClose={onClose}
      title={LIBRARY_LABEL}
      detent="full"
      panelClassName="segment-library-sheet"
    >
      <SegmentLibraryBody library={library} layout="list" />
    </Sheet>
  );
}

type Props = Pick<ViewProps, "open" | "onClose">;

export function SegmentLibrarySheet({ open, onClose }: Props) {
  const library = useSegmentLibrary(open);
  return (
    <SegmentLibrarySheetView open={open} onClose={onClose} library={library} />
  );
}
