export const LIBRARY_CHANGED_EVENT = "sharecut:library-changed";

export type LibraryChanged = { segmentId?: string };

/** Tells every mounted library list to read again; a list another host just added to, say. */
export function announceLibraryChanged(segmentId?: string): void {
  window.dispatchEvent(
    new CustomEvent<LibraryChanged>(LIBRARY_CHANGED_EVENT, {
      detail: { segmentId },
    }),
  );
}

export function segmentIdOf(event: Event): string | undefined {
  const detail = (event as CustomEvent<LibraryChanged | null>).detail;
  return typeof detail?.segmentId === "string" ? detail.segmentId : undefined;
}
