import { Button } from "../../ui";
import { SystemIcon } from "../SystemIcon";
import { useBundleImport } from "./BundleImportContext";
import { IMPORT_LABEL } from "./bundleCopy";

/** The one Import button: a native button that opens the host's file picker for a segment or a kit file. */
export function BundleImportButton() {
  const controls = useBundleImport();
  if (!controls) return null;
  return (
    <Button
      ref={controls.buttonRef}
      className="segment-import-button"
      onClick={controls.pick}
    >
      <SystemIcon name="file-plus" size={16} />
      {IMPORT_LABEL}
    </Button>
  );
}
