import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { KitImportPreview } from "../../kits/KitImportPreview";
import { useKitImport } from "../../kits/useKitImport";
import type { KitLibraryState } from "../../kits/useKitLibrary";
import { SegmentImportPreview } from "../../segments/SegmentImportPreview";
import { useSegmentImport } from "../../segments/useSegmentImport";
import type { SegmentLibraryState } from "../../segments/useSegmentLibrary";
import { useDawStore } from "../../state/dawStore";
import {
  BundleImportContext,
  type BundleImportControls,
} from "./BundleImportContext";
import {
  looksLikeBundle,
  NOT_A_BUNDLE_FILE,
  ONE_FILE_ONLY,
} from "./bundleCopy";
import { classifyBundle } from "./classifyBundle";
import { WAIT_TO_DROP } from "./importCopy";

type Props = {
  segments: SegmentLibraryState;
  /** Left out where the library shows no kits. */
  kits?: KitLibraryState;
  /** Whether a file dropped anywhere on the window is taken; the Library sheet takes over from Home. */
  listening?: boolean;
  children: ReactNode;
};

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function refuse(message: string): void {
  useDawStore.getState().announceStatus(message, { tone: "error" });
}

/**
 * Owns the segment and the kit import for the Library lists below it: one Import button
 * and drop take either kind of file, routed by what is inside, and the one sheet that
 * shows the waiting file. Host only: for a guest it renders its children and nothing else.
 */
export function BundleImportHost({
  segments,
  kits,
  listening = true,
  children,
}: Props) {
  const hosted = useDawStore((s) => s.guestMode === null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const kitsHeadingRef = useRef<HTMLElement>(null);
  const classifying = useRef(false);
  const wasImporting = useRef(false);

  const { reveal } = segments;
  const reloadKits = kits?.reload;
  const reloadSegments = segments.reload;

  const segmentImport = useSegmentImport({
    onDone: (id, message) => {
      reveal(id);
      useDawStore.getState().announceStatus(message);
    },
  });
  const kitImport = useKitImport({
    onChanged: () => {
      reloadKits?.();
      reloadSegments();
    },
    onDone: (message, firstSegmentId) => {
      useDawStore.getState().announceStatus(message);
      reloadKits?.();
      if (firstSegmentId) reveal(firstSegmentId);
      else reloadSegments();
    },
  });

  const importing =
    segmentImport.state.phase !== "idle" || kitImport.state.phase !== "idle";
  const busyRef = useRef(importing);
  useEffect(() => {
    busyRef.current = importing;
  });

  useEffect(() => {
    if (wasImporting.current && !importing)
      (buttonRef.current ?? kitsHeadingRef.current)?.focus();
    wasImporting.current = importing;
  }, [importing]);

  const chooseSegment = segmentImport.choose;
  const chooseKit = kitImport.choose;
  const choose = useCallback(
    (file: File) => {
      if (busyRef.current || classifying.current) {
        refuse(WAIT_TO_DROP);
        return;
      }
      classifying.current = true;
      void classifyBundle(file)
        .then((kind) => {
          if (kind === "kit") chooseKit(file);
          else if (kind === "segment") chooseSegment(file);
          else refuse(NOT_A_BUNDLE_FILE);
        })
        .finally(() => {
          classifying.current = false;
        });
    },
    [chooseKit, chooseSegment],
  );

  // A segment or kit file dropped anywhere on the page. This listens on the document, which
  // sees a drop after the list that took it and before the window listeners (Home's audio
  // drop), so a nearer target keeps its claim and ours is seen by the audio drop as taken.
  // Audio and every other file are left to those listeners.
  const latest = useRef(choose);
  useEffect(() => {
    latest.current = choose;
  });
  useEffect(() => {
    if (!hosted || !listening) return;
    // A drop only fires on a target that accepted the drag; names are not readable yet.
    const over = (event: DragEvent) => {
      if (!carriesFiles(event) || event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event) || event.defaultPrevented) return;
      const files = Array.from(event.dataTransfer?.files ?? []).filter(
        looksLikeBundle,
      );
      if (files.length === 0) return;
      event.preventDefault();
      if (files.length > 1) refuse(ONE_FILE_ONLY);
      else latest.current(files[0] as File);
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [hosted, listening]);

  const controls = useMemo<BundleImportControls>(
    () => ({ choose, busy: importing, inputRef, buttonRef, kitsHeadingRef }),
    [choose, importing],
  );

  if (!hosted) return <>{children}</>;
  return (
    <BundleImportContext.Provider value={controls}>
      {children}
      <SegmentImportPreview
        state={segmentImport.state}
        onAdd={segmentImport.add}
        onCancel={segmentImport.cancel}
        onChooseAgain={() => inputRef.current?.click()}
      />
      <KitImportPreview
        state={kitImport.state}
        onAdd={kitImport.add}
        onCancel={kitImport.cancel}
        onChooseAgain={() => inputRef.current?.click()}
      />
    </BundleImportContext.Provider>
  );
}
