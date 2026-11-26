import { useEffect } from "react";
import { useViewportClass } from "../hooks/useViewportClass";
import { KitLibrary, type KitLibraryState, useKitLibrary } from "../kits";
import { useDawStore } from "../state/dawStore";
import { BundleImportHost } from "../system/importSheet/BundleImportHost";
import { Sheet } from "../system/Sheet";
import { LIBRARY_LABEL, SegmentLibraryBody } from "./SegmentLibraryBody";
import {
  type SegmentLibraryState,
  useSegmentLibrary,
} from "./useSegmentLibrary";

type ViewProps = {
  open: boolean;
  onClose: () => void;
  library: SegmentLibraryState;
  kits?: KitLibraryState;
};

export function SegmentLibrarySheetView({
  open,
  onClose,
  library,
  kits,
}: ViewProps) {
  const phone = useViewportClass() === "phone";
  return (
    <Sheet
      form={phone ? "bottom" : "end"}
      open={open}
      onClose={onClose}
      title={LIBRARY_LABEL}
      detent="full"
    >
      <BundleImportHost segments={library} kits={kits}>
        <div className="kit-sheet-stack">
          <SegmentLibraryBody library={library} layout="list" />
          {kits ? <KitLibrary library={kits} segments={library} /> : null}
        </div>
      </BundleImportHost>
    </Sheet>
  );
}

type Props = Pick<ViewProps, "open" | "onClose"> & {
  library?: SegmentLibraryState;
  kits?: KitLibraryState;
};

export function SegmentLibrarySheet({ open, onClose, library, kits }: Props) {
  const own = useSegmentLibrary(open && !library);
  const hosted = useDawStore((s) => s.guestMode === null);
  const ownKits = useKitLibrary(open && hosted && !kits);
  // Kits handed in by Home were read when Home mounted; read them again on each open,
  // as the segment list is.
  const handed = kits?.reload;
  useEffect(() => {
    if (open && hosted) handed?.();
  }, [open, hosted, handed]);
  return (
    <SegmentLibrarySheetView
      open={open}
      onClose={onClose}
      library={library ?? own}
      kits={kits ?? ownKits}
    />
  );
}
