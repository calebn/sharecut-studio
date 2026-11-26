import { useEffect, useRef, useState } from "react";
import {
  applyKit,
  isDamagedSegment,
  type KitOfferKit,
  loadKitOffer,
  loadSegments,
  undoHistory,
} from "../../api";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import {
  documentScope,
  isCurrentDocumentScope,
} from "../../document/authorityState";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import { parseHistoryEntryId } from "../../types/project";
import { ApiError, errorMessage, isAbortError } from "../../utils/apiError";
import { isTerminalJobStatus } from "../../utils/pipeline";
import { readLocal, writeLocal } from "../../utils/storage";
import {
  appliedLine,
  KIT_OFFER_ADD,
  KIT_OFFER_ADDING,
  KIT_OFFER_NOT_NOW,
  KIT_OFFER_TITLE,
  KIT_UNDO_DWELL_MS,
  offerDetail,
  partialUndoLine,
  UNDONE_LINE,
} from "./kitOfferCopy";
import { FRAME_ALERT_PRIORITY, useFrameAlert } from "./useFrameAlert";

type Offered = {
  path: string;
  epoch: number;
  kit: KitOfferKit;
  names: ReadonlyMap<string, string>;
};

const dismissedKey = (path: string, kitId: string) =>
  `sharecut.kitOffer.dismissed:${path}:${kitId}`;

const isCurrent = (path: string, epoch: number) => {
  const store = useDawStore.getState();
  return store.projectPath === path && store.projectEpoch === epoch;
};

async function undoKit(
  path: string,
  steps: number,
  firstHead: string | null,
): Promise<boolean | string> {
  const scope = documentScope();
  let head = parseHistoryEntryId(firstHead);
  let undone = 0;
  while (undone < steps && head !== null && isCurrentDocumentScope(scope)) {
    try {
      head = await undoHistory(path, { expectedHeadId: head, scope });
    } catch (error) {
      if (!(error instanceof ApiError) && undone === 0) throw error;
      break;
    }
    if (head === null) break;
    undone += 1;
  }
  if (undone === steps) return true;
  return undone === 0 ? false : partialUndoLine(undone, steps);
}

type Scope = { path: string; epoch: number };
const sameScope = (a: Scope | null, b: Scope) =>
  a !== null && a.path === b.path && a.epoch === b.epoch;

/** Offers the show kit in the frame's alert slot when a host's episode has audio and no segments yet. */
export function KitOfferNotice({ guestShare }: { guestShare: boolean }) {
  const path = useDaw((s) => s.projectPath);
  const epoch = useDaw((s) => s.projectEpoch);
  const guestMode = useDaw((s) => s.guestMode);
  const hasClips = useDaw((s) => (s.project?.clips.clip_count ?? 0) > 0);
  const endedJobId = useDaw((s) =>
    s.activityJob && isTerminalJobStatus(s.activityJob.status)
      ? s.activityJob.id
      : null,
  );
  const [offered, setOffered] = useState<Offered | null>(null);
  const [reread, setReread] = useState(0);
  const [applying, setApplying] = useState<Scope | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const busy = useRef<Scope | null>(null);
  const enabled = !guestShare && guestMode === null && path !== "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: these only signal that the offer may have changed
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const offer = await loadKitOffer(path, signal);
        const kit = offer.offer ? offer.kits[0] : undefined;
        if (!kit) return setOffered(null);
        const rows = await loadSegments(signal).catch((e: unknown) => {
          if (isAbortError(e)) throw e;
          return [];
        });
        const names = new Map<string, string>();
        for (const row of rows)
          if (!isDamagedSegment(row)) names.set(row.id, row.name);
        if (!signal.aborted && !sameScope(busy.current, { path, epoch }))
          setOffered({ path, epoch, kit, names });
      } catch {
        if (!signal.aborted) setOffered(null);
      }
    })();
    return () => controller.abort();
  }, [enabled, path, epoch, hasClips, endedJobId, reread]);

  const current =
    enabled && offered?.path === path && offered.epoch === epoch
      ? offered
      : null;
  const key = current ? dismissedKey(path, current.kit.id) : null;
  const dismissed = key !== null && (hidden === key || readLocal(key) !== null);

  const reload = () => {
    if (isCurrent(path, epoch)) setReread((n) => n + 1);
  };

  const apply = async (target: Offered) => {
    const scope = { path, epoch };
    if (sameScope(busy.current, scope)) return;
    busy.current = scope;
    setApplying(scope);
    setOffered(null);
    const say = useDawStore.getState().announceStatus;
    try {
      const report = await applyKit(path, target.kit);
      await refreshDocumentProject(path).catch(() => undefined);
      if (!isCurrent(path, epoch)) return;
      say(appliedLine(target.kit.entries, target.names, report.undo_steps), {
        reverse: {
          run: async () => {
            if (!isCurrent(path, epoch)) return false;
            const result = await undoKit(
              path,
              report.undo_steps,
              report.history_head_id,
            );
            reload();
            return result;
          },
          done: UNDONE_LINE,
        },
        dwellMs: KIT_UNDO_DWELL_MS,
      });
    } catch (error) {
      await refreshDocumentProject(path).catch(() => undefined);
      if (isCurrent(path, epoch))
        say(errorMessage(error, "Could not add them."), { tone: "error" });
    } finally {
      if (busy.current === scope) busy.current = null;
      setApplying((now) => (now === scope ? null : now));
      reload();
    }
  };

  const notNow = (id: string) => {
    writeLocal(id, "1");
    setHidden(id);
  };

  useFrameAlert(
    FRAME_ALERT_PRIORITY.offer,
    sameScope(applying, { path, epoch })
      ? { state: "running", title: KIT_OFFER_ADDING }
      : current && !dismissed
        ? {
            state: "needs-you",
            title: KIT_OFFER_TITLE,
            detail: offerDetail(current.kit.entries, current.names),
            action: {
              label: KIT_OFFER_ADD,
              onAction: () => void apply(current),
            },
            secondaryAction: {
              label: KIT_OFFER_NOT_NOW,
              onAction: () => key && notNow(key),
            },
          }
        : null,
  );
  return null;
}
