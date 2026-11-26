import { createContext, type RefObject, useContext } from "react";

/** What the library toolbar and lists need from the host that owns the imports. */
export type BundleImportControls = {
  /** Routes a picked or dropped file to the segment or kit import by what it is. */
  choose: (file: File) => void;
  /** True while either import is past idle, so a second file is not taken. */
  busy: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** Takes focus after an import closes when the Import button has gone. */
  kitsHeadingRef: RefObject<HTMLElement | null>;
};

export const BundleImportContext = createContext<BundleImportControls | null>(
  null,
);

/** The host's controls, or null for a guest and wherever no host is mounted. */
export function useBundleImport(): BundleImportControls | null {
  return useContext(BundleImportContext);
}
