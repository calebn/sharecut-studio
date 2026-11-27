import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dropInboxFile, fetchInboxFile } from "../../api";
import {
  drainOpenBundleQueue,
  OPEN_BUNDLE_EVENT,
  type OpenBundleItem,
} from "../../desktop/openBundleQueue";
import { desktopCloseGuardArmed } from "../../desktop/useDesktopCloseGuard";
import type { KitLibraryState } from "../../kits/useKitLibrary";
import { announceLibraryChanged } from "../../segments/libraryChanged";
import type { SegmentLibraryState } from "../../segments/useSegmentLibrary";
import { useDawStore } from "../../state/dawStore";
import { ApiError } from "../../utils/apiError";
import { useBundleImport } from "./BundleImportContext";
import { BundleImportHost } from "./BundleImportHost";
import {
  OPEN_FILE_FAILED,
  OPEN_FILE_GONE,
  OPEN_FILE_TOO_LARGE,
} from "./bundleCopy";
import { openImportBusy, useOpenImportBusy } from "./openImportSignal";

/** A received file becomes one in-memory Blob; larger than this is refused rather than risking the WebView. */
export const MAX_RECEIVED_BYTES = 256 * 1024 * 1024;

export const FINISH_THE_TAKE = "Finish the take, then your file will open.";

const RETRY_MS = 1000;

function refuse(message: string): void {
  useDawStore.getState().announceStatus(message, { tone: "error" });
}

/** The library lists on screen own their rows; this host only tells them to read again. */
const SEGMENTS: SegmentLibraryState = {
  rows: null,
  error: null,
  highlightId: null,
  reload: () => announceLibraryChanged(),
  reveal: (id) => announceLibraryChanged(id),
  remove: async () => null,
};
const KITS: KitLibraryState = {
  rows: null,
  error: null,
  highlightId: null,
  reload: () => announceLibraryChanged(),
  reveal: () => announceLibraryChanged(),
};

function dropQuietly(id: string): void {
  void dropInboxFile(id).catch(() => {});
}

function holdActive(): boolean {
  return openImportBusy() || desktopCloseGuardArmed();
}

/**
 * Reads one received file and drops the inbox copy once the page holds it. The holds are
 * checked again after the read, which can take a while; a file that meets one is kept in
 * `pending` and reported as not done, so the feeder offers it again when the hold clears.
 */
async function receive(
  item: OpenBundleItem,
  choose: (file: File) => void,
  pending: Map<string, File>,
  signal: AbortSignal,
): Promise<boolean> {
  if (item.size > MAX_RECEIVED_BYTES) {
    refuse(OPEN_FILE_TOO_LARGE);
    dropQuietly(item.id);
    return true;
  }
  let file = pending.get(item.id);
  if (!file) {
    try {
      file = await fetchInboxFile(item.id, item.name, signal);
    } catch (failure) {
      if (signal.aborted) return false;
      const gone = failure instanceof ApiError && failure.status === 404;
      refuse(gone ? OPEN_FILE_GONE : OPEN_FILE_FAILED);
      if (!gone) dropQuietly(item.id);
      return true;
    }
    if (signal.aborted) return false;
    pending.set(item.id, file);
    dropQuietly(item.id);
  }
  if (holdActive()) return false;
  pending.delete(item.id);
  try {
    choose(file);
  } catch {
    refuse(OPEN_FILE_FAILED);
  }
  return true;
}

function Feeder({
  items,
  onTaken,
}: {
  items: readonly OpenBundleItem[];
  onTaken: (id: string) => void;
}) {
  const bundle = useBundleImport();
  const busy = useOpenImportBusy();
  const working = useRef(false);
  const told = useRef<string | null>(null);
  const pending = useRef(new Map<string, File>());
  const inflight = useRef<AbortController | null>(null);
  const [tick, setTick] = useState(0);
  const head = items[0];

  useEffect(() => {
    const held = pending.current;
    return () => {
      inflight.current?.abort();
      inflight.current = null;
      working.current = false;
      held.clear();
    };
  }, []);

  useEffect(() => {
    void busy;
    void tick;
    if (!head || !bundle || working.current || openImportBusy()) return;
    if (desktopCloseGuardArmed()) {
      if (told.current !== head.id) {
        told.current = head.id;
        useDawStore.getState().announceStatus(FINISH_THE_TAKE);
      }
      const timer = window.setTimeout(() => setTick((n) => n + 1), RETRY_MS);
      return () => window.clearTimeout(timer);
    }
    working.current = true;
    const controller = new AbortController();
    inflight.current = controller;
    void receive(head, bundle.choose, pending.current, controller.signal).then(
      (done) => {
        if (controller.signal.aborted) return;
        working.current = false;
        if (done) onTaken(head.id);
        else setTick((n) => n + 1);
      },
    );
  }, [head, bundle, busy, tick, onTaken]);

  return null;
}

function ReceivedBundles() {
  const [items, setItems] = useState<readonly OpenBundleItem[]>([]);

  useEffect(() => {
    const drain = () => {
      const fresh = drainOpenBundleQueue();
      if (fresh.length > 0) setItems((held) => [...held, ...fresh]);
    };
    drain();
    window.addEventListener(OPEN_BUNDLE_EVENT, drain);
    return () => window.removeEventListener(OPEN_BUNDLE_EVENT, drain);
  }, []);

  const onTaken = useCallback(
    (id: string) => setItems((held) => held.filter((item) => item.id !== id)),
    [],
  );
  const feeder = useMemo(
    () => <Feeder items={items} onTaken={onTaken} />,
    [items, onTaken],
  );

  return (
    <BundleImportHost segments={SEGMENTS} kits={KITS} listening={false}>
      {feeder}
    </BundleImportHost>
  );
}

/**
 * Stages the segment or kit file the iOS app received from the share sheet: the sheet opens
 * over whatever screen is showing, one file at a time, and never navigates. The file waits
 * while another import sheet is open or a take is armed. Not for a guest, nor outside the app.
 */
export function OpenBundleHost() {
  const hosted = useDawStore((s) => s.guestMode === null);
  if (!hosted || !isTauri()) return null;
  return <ReceivedBundles />;
}
