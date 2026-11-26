import type { ChangeEvent, RefObject } from "react";
import { SystemIcon } from "../system/SystemIcon";
import { Button } from "../ui";
import { IMPORT_ACCEPT, IMPORT_LABEL } from "./importMessages";

type Props = {
  onChoose: (file: File) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
};

/** A native button that opens the file picker; the input itself stays hidden. */
export function SegmentImportButton({ onChoose, inputRef, buttonRef }: Props) {
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onChoose(file);
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
