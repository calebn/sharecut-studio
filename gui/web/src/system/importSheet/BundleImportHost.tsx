import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { audioFilesFromDrop } from "../../ingest/dropLabels";
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
  IMPORT_ACCEPT,
  looksLikeBundle,
  NOT_A_BUNDLE_FILE,
  ONE_FILE_ONLY,
} from "./bundleCopy";
import { classifyBundle } from "./classifyBundle";
import { IMPORT_FAILED, WAIT_TO_DROP } from "./importCopy";

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

export const AUDIO_NOT_ADDED =
  "Audio in the same drop wasn't added. Drop it on its own.";

function refuse(message: string): void {
  useDawStore.getState().announceStatus(message, { tone: "error" });
}

/** The main region takes focus when nothing nearer is left to return it to. */
function mainRegion(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>("main");
  if (main && !main.hasAttribute("tabindex")) main.tabIndex = -1;
  return main;
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
  const opener = useRef<HTMLElement | null>(null);
  const [aside, setAside] = useState<string | null>(null);

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
  // A file in flight blocks a new one; a preview or an error does not (it is replaced).
  const busy = [segmentImport.state.phase, kitImport.state.phase].some(
    (phase) => phase === "uploading" || phase === "committing",
  );
  const busyRef = useRef(busy);
  useLayoutEffect(() => {
    busyRef.current = busy;
  });

  useEffect(() => {
    if (wasImporting.current && !importing) {
      const before = opener.current;
      opener.current = null;
      setAside(null);
      const target = before?.isConnected
        ? before
        : (buttonRef.current ?? kitsHeadingRef.current ?? mainRegion());
      target?.focus();
    }
    wasImporting.current = importing;
  }, [importing]);

  // A status toast from the last import would sit over the buttons of the next sheet.
  const segmentPhase = segmentImport.state.phase;
  const kitPhase = kitImport.state.phase;
  useEffect(() => {
    const opens = [segmentPhase, kitPhase].some(
      (phase) => phase === "preview" || phase === "error",
    );
    if (!opens) return;
    const { feedbackToast, dismissFeedbackToast } = useDawStore.getState();
    if (feedbackToast) dismissFeedbackToast(feedbackToast.id);
  }, [segmentPhase, kitPhase]);

  const chooseSegment = segmentImport.choose;
  const chooseKit = kitImport.choose;
  const cancelSegment = segmentImport.cancel;
  const cancelKit = kitImport.cancel;
  const choose = useCallback(
    (file: File, note?: string) => {
      if (busyRef.current || classifying.current) {
        refuse(WAIT_TO_DROP);
        return;
      }
      if (!wasImporting.current) {
        const active = document.activeElement;
        opener.current =
          active instanceof HTMLElement && active !== document.body
            ? active
            : null;
      }
      classifying.current = true;
      void classifyBundle(file)
        .then((kind) => {
          // One sheet at a time: a waiting file of the other kind is dropped first.
          if (kind !== "unknown") setAside(note ?? null);
          if (kind === "kit") {
            cancelSegment();
            chooseKit(file);
          } else if (kind === "segment") {
            cancelKit();
            chooseSegment(file);
          } else refuse(NOT_A_BUNDLE_FILE);
        })
        .catch(() => refuse(IMPORT_FAILED))
        .finally(() => {
          classifying.current = false;
        });
    },
    [chooseKit, chooseSegment, cancelKit, cancelSegment],
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
      const dropped = Array.from(event.dataTransfer?.files ?? []);
      const files = dropped.filter(looksLikeBundle);
      if (files.length === 0) return;
      // Claiming the drop also keeps the window's audio drop from seeing it.
      event.preventDefault();
      if (files.length > 1) refuse(ONE_FILE_ONLY);
      else {
        latest.current(
          files[0] as File,
          audioFilesFromDrop(dropped).length > 0 ? AUDIO_NOT_ADDED : undefined,
        );
      }
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [hosted, listening]);

  const pick = useCallback(() => inputRef.current?.click(), []);
  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) choose(file);
  };

  const controls = useMemo<BundleImportControls>(
    () => ({ choose, pick, busy, buttonRef, kitsHeadingRef }),
    [choose, pick, busy],
  );

  if (!hosted) return <>{children}</>;
  return (
    <BundleImportContext.Provider value={controls}>
      {children}
      <input
        ref={inputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={onPicked}
      />
      <SegmentImportPreview
        state={segmentImport.state}
        onAdd={segmentImport.add}
        onCancel={segmentImport.cancel}
        onChooseAgain={pick}
        aside={aside}
      />
      <KitImportPreview
        state={kitImport.state}
        onAdd={kitImport.add}
        onCancel={kitImport.cancel}
        onChooseAgain={pick}
        aside={aside}
      />
    </BundleImportContext.Provider>
  );
}
