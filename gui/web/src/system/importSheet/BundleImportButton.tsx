import type { ChangeEvent } from "react";
import { Button } from "../../ui";
import { SystemIcon } from "../SystemIcon";
import { useBundleImport } from "./BundleImportContext";
import { IMPORT_ACCEPT, IMPORT_LABEL } from "./bundleCopy";

/** The one Import button: a native button that opens the file picker for a segment or a kit file. */
export function BundleImportButton() {
  const controls = useBundleImport();
  if (!controls) return null;
  const { choose, inputRef, buttonRef } = controls;
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) choose(file);
  };
  return (
    <>
      <Button
        ref={buttonRef}
        className="segment-import-button"
        onClick={() => inputRef.current?.click()}
      >
        <SystemIcon name="file-plus" size={16} />
        {IMPORT_LABEL}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
      />
    </>
  );
}
