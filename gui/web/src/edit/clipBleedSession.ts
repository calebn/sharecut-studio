import {
  type ClipBleedInspection,
  type ClipBleedRequest,
  loadClipBleedInspection,
  type OpaqueBleedRestoreTarget,
  type RestoreOutcome,
} from "../api/clipBleed";
import {
  type DocumentScope,
  documentAuthority,
  documentScope,
  isCurrentDocumentScope,
  ownCommandHead,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import type { HistoryEntryId } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { bleedAttenuationRegionKey } from "./bleedAttenuation";
import { rangeClips } from "./rangeSelection";

export type ClipBleedOccurrence = Omit<ClipBleedRequest, "projectPath">;
export type ClipBleedRead =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; inspection: ClipBleedInspection };
export type ClipBleedAction =
  | { state: "idle" }
  | { state: "saving" | "undoing"; elapsedSeconds?: number }
  | { state: "error"; code: "STALE_TARGET" | "failed"; message: string };
export type ClipBleedTarget = Readonly<{
  target: OpaqueBleedRestoreTarget;
  generation: number;
  scope: DocumentScope;
  projectEpoch: number;
  trackId: string;
  clipId: string;
}>;
export type ClipBleedUndoReceipt = Readonly<{
  scope: DocumentScope;
  projectEpoch: number;
  trackId: string;
  clipId: string;
  generation: number;
  expectedHeadId: HistoryEntryId;
  originOccurrenceKind: "implicit" | "explicit";
}>;
export type ClipBleedActionTicket = Readonly<{
  kind: "restore" | "undo";
  id: symbol;
}>;
export type ClipBleedSnapshot = Readonly<{
  occurrence: ClipBleedOccurrence;
  generation: number;
  read: ClipBleedRead;
  selectedKey: string | null;
  action: ClipBleedAction;
  undo: ClipBleedUndoReceipt | null;
}> | null;

type Context = {
  scope: DocumentScope;
  projectEpoch: number;
  authorityBasis: string;
  occurrenceBasis: string;
  occurrenceKind: "implicit" | "explicit";
  materializationBasis: string | null;
};

type ActionIntent =
  | { kind: "restore" }
  | { kind: "undo"; receipt: ClipBleedUndoReceipt };
type PendingAction = ActionIntent & {
  ticket: ClipBleedActionTicket;
  context: Context;
  originOccurrenceKind: Context["occurrenceKind"];
  headTransition: {
    state: "opening" | "advanced";
    head: HistoryEntryId | null;
  };
};

const STALE_MESSAGE =
  "This region changed. Refresh regions and select it again.";

function contextFor(occurrence: ClipBleedOccurrence): Context | null {
  const state = useDawStore.getState();
  const scope = documentScope();
  const project = state.projectEditBasis();
  if (!scope.path || scope.path !== state.projectPath || !project) return null;
  const track = project.tracks.find((row) => row.id === occurrence.trackId);
  const clip = rangeClips(project).find(
    (row) =>
      row.id === occurrence.clipId && row.track_id === occurrence.trackId,
  );
  if (!track || !clip) return null;
  const occurrenceKind = (project.clips.tracks[track.id] ?? []).some(
    (row) => row.id === clip.id,
  )
    ? "explicit"
    : "implicit";
  const automaticRegions =
    Object.entries(clip).find(
      ([key]) => key === "off_speaker_mute_regions",
    )?.[1] ?? [];
  return {
    scope,
    projectEpoch: state.projectEpoch,
    authorityBasis: JSON.stringify([
      documentAuthority.seq,
      documentAuthority.token,
      documentAuthority.file,
      documentAuthority.phase,
      currentHead(scope),
    ]),
    occurrenceBasis: JSON.stringify([
      Object.fromEntries(
        Object.entries(clip).filter(([key]) => key !== "bleed_restore"),
      ),
      track.media_path,
      track.range_media_seal,
      track.duration_sec,
      track.role,
      project.effects_by_track,
      project.envelopes,
    ]),
    occurrenceKind,
    materializationBasis: track.range_media_seal
      ? JSON.stringify([
          clip.id,
          clip.track_id,
          clip.source_id,
          clip.source_start,
          clip.source_end,
          clip.timeline_start,
          clip.timeline_end,
          clip.fade_in_ms,
          clip.fade_out_ms,
          clip.join_in_mode,
          clip.mute_regions ?? [],
          automaticRegions,
          track.range_media_seal,
          track.media_path,
          track.duration_sec,
          track.role,
          project.effects_by_track,
          project.envelopes,
        ])
      : null,
  };
}

function sameOpening(a: Context, b: Context): boolean {
  return (
    isCurrentDocumentScope(a.scope) &&
    a.scope.path === b.scope.path &&
    a.scope.generation === b.scope.generation &&
    a.projectEpoch === b.projectEpoch
  );
}

function sameLifetime(a: Context, b: Context): boolean {
  return sameOpening(a, b) && a.occurrenceBasis === b.occurrenceBasis;
}

function isMaterialization(a: Context, b: Context): boolean {
  return (
    sameOpening(a, b) &&
    a.occurrenceKind === "implicit" &&
    b.occurrenceKind === "explicit" &&
    a.materializationBasis !== null &&
    a.materializationBasis === b.materializationBasis
  );
}

function sameActionLifetime(action: PendingAction, current: Context): boolean {
  if (sameLifetime(action.context, current)) return true;
  return action.kind === "restore"
    ? isMaterialization(action.context, current)
    : action.receipt.originOccurrenceKind === "implicit" &&
        isMaterialization(current, action.context);
}

function sameInspection(a: Context, b: Context): boolean {
  return sameLifetime(a, b) && a.authorityBasis === b.authorityBasis;
}

function currentHead(scope: DocumentScope): HistoryEntryId | null {
  const shown = useDawStore.getState().project?.history.head_id ?? null;
  return ownCommandHead(scope, shown)?.head ?? shown;
}

export function createClipBleedSession(
  load: typeof loadClipBleedInspection = loadClipBleedInspection,
) {
  let snapshot: ClipBleedSnapshot = null;
  let context: Context | null = null;
  let generation = 0;
  let request: AbortController | null = null;
  let detachOpening: (() => void) | null = null;
  let action: PendingAction | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: ClipBleedSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const stopRead = () => {
    request?.abort();
    request = null;
  };
  const retire = () => {
    generation++;
    stopRead();
    detachOpening?.();
    detachOpening = null;
    context = null;
    action = null;
    if (snapshot) publish(null);
  };
  const synchronize = () => {
    if (!snapshot || !context) return;
    const current = contextFor(snapshot.occurrence);
    const ownMaterialization =
      current &&
      snapshot.undo &&
      currentHead(context.scope) === snapshot.undo.expectedHeadId &&
      isMaterialization(context, current);
    if (
      !current ||
      !(action
        ? sameActionLifetime(action, current)
        : sameLifetime(context, current) || ownMaterialization)
    ) {
      retire();
      return;
    }
    if (action) {
      const head = currentHead(current.scope);
      if (head !== action.headTransition.head) {
        if (action.headTransition.state === "advanced") {
          retire();
          return;
        }
        action.headTransition = { state: "advanced", head };
      }
      if (
        action.kind === "restore" &&
        isMaterialization(action.context, current)
      )
        action.context = current;
    }
    if (ownMaterialization) context = current;
    if (!sameInspection(context, current) && snapshot.read.state !== "error") {
      stopRead();
      publish({
        ...snapshot,
        read: { state: "error", message: STALE_MESSAGE },
        selectedKey: null,
        undo: null,
      });
    }
    if (
      snapshot?.undo &&
      currentHead(context.scope) !== snapshot.undo.expectedHeadId
    )
      publish({ ...snapshot, undo: null });
  };
  const unsubscribeStore = useDawStore.subscribe(synchronize);

  const loadOccurrence = async (occurrence: ClipBleedOccurrence) => {
    retire();
    const opening = contextFor(occurrence);
    if (!opening) return;
    context = opening;
    const abort = documentAuthority.abort;
    abort.signal.addEventListener("abort", retire, { once: true });
    detachOpening = () => abort.signal.removeEventListener("abort", retire);
    const controller = new AbortController();
    request = controller;
    const issued = generation;
    publish({
      occurrence,
      generation: issued,
      read: { state: "loading" },
      selectedKey: null,
      action: { state: "idle" },
      undo: null,
    });
    try {
      const inspection = await load(
        { ...occurrence, projectPath: opening.scope.path },
        controller.signal,
      );
      synchronize();
      const current = contextFor(occurrence);
      if (
        controller.signal.aborted ||
        issued !== generation ||
        !snapshot ||
        !current ||
        !sameInspection(opening, current)
      )
        return;
      request = null;
      publish({ ...snapshot, read: { state: "ready", inspection } });
    } catch (error) {
      synchronize();
      if (controller.signal.aborted || issued !== generation || !snapshot)
        return;
      request = null;
      publish({
        ...snapshot,
        read: { state: "error", message: errorMessage(error) },
      });
    }
  };

  const currentTarget = (
    expected?: ClipBleedTarget,
  ): ClipBleedTarget | null => {
    synchronize();
    if (!snapshot || !context || snapshot.read.state !== "ready") return null;
    const current = contextFor(snapshot.occurrence);
    if (!current || !sameInspection(context, current)) return null;
    const region = snapshot.read.inspection.regions.find(
      (row) => bleedAttenuationRegionKey(row) === snapshot?.selectedKey,
    );
    if (!region || region.restore.state !== "available") return null;
    const target: ClipBleedTarget = {
      target: region.restore.target,
      generation: snapshot.generation,
      scope: context.scope,
      projectEpoch: context.projectEpoch,
      trackId: snapshot.occurrence.trackId,
      clipId: snapshot.occurrence.clipId,
    };
    return expected &&
      (expected.target !== target.target ||
        expected.generation !== target.generation ||
        expected.scope.path !== target.scope.path ||
        expected.scope.generation !== target.scope.generation ||
        expected.projectEpoch !== target.projectEpoch ||
        expected.trackId !== target.trackId ||
        expected.clipId !== target.clipId)
      ? null
      : target;
  };
  const currentUndo = (expected: ClipBleedUndoReceipt): boolean => {
    synchronize();
    return !!snapshot && snapshot.undo === expected;
  };
  const beginAction = (intent: ActionIntent) => {
    if (!snapshot || !context || action) return null;
    const ticket: ClipBleedActionTicket = {
      kind: intent.kind,
      id: Symbol(intent.kind),
    };
    action = {
      ...intent,
      ticket,
      context,
      originOccurrenceKind: context.occurrenceKind,
      headTransition: { state: "opening", head: currentHead(context.scope) },
    };
    publish({
      ...snapshot,
      action: { state: intent.kind === "restore" ? "saving" : "undoing" },
      undo: null,
    });
    return ticket;
  };
  const accepts = (ticket: ClipBleedActionTicket): boolean => {
    synchronize();
    if (!snapshot || !action || action.ticket !== ticket) return false;
    const current = contextFor(snapshot.occurrence);
    return !!current && sameActionLifetime(action, current);
  };

  return {
    getSnapshot: (): ClipBleedSnapshot => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: (occurrence: ClipBleedOccurrence): Promise<void> => {
      synchronize();
      if (
        snapshot?.occurrence.trackId === occurrence.trackId &&
        snapshot.occurrence.clipId === occurrence.clipId
      )
        return Promise.resolve();
      return loadOccurrence(occurrence);
    },
    refresh: (): Promise<void> =>
      snapshot ? loadOccurrence(snapshot.occurrence) : Promise.resolve(),
    select: (key: string | null): boolean => {
      synchronize();
      if (!snapshot || snapshot.read.state !== "ready" || action) return false;
      if (
        key !== null &&
        !snapshot.read.inspection.regions.some(
          (region) => bleedAttenuationRegionKey(region) === key,
        )
      )
        return false;
      if (snapshot.selectedKey !== key)
        publish({ ...snapshot, selectedKey: key });
      return true;
    },
    currentTarget,
    currentUndo,
    beginRestore: (expected: ClipBleedTarget): ClipBleedActionTicket | null =>
      currentTarget(expected) ? beginAction({ kind: "restore" }) : null,
    beginUndo: (receipt: ClipBleedUndoReceipt): ClipBleedActionTicket | null =>
      currentUndo(receipt) ? beginAction({ kind: "undo", receipt }) : null,
    finishRestore: (
      ticket: ClipBleedActionTicket,
      outcome: RestoreOutcome,
    ): boolean => {
      if (
        !accepts(ticket) ||
        ticket.kind !== "restore" ||
        !snapshot ||
        !context
      )
        return false;
      const originOccurrenceKind = action!.originOccurrenceKind;
      context = contextFor(snapshot.occurrence)!;
      action = null;
      stopRead();
      const acknowledged =
        outcome.status === "acknowledged" &&
        currentHead(context.scope) === outcome.historyHead;
      publish({
        ...snapshot,
        read: { state: "error", message: STALE_MESSAGE },
        selectedKey: null,
        action:
          outcome.status === "unconfirmed"
            ? {
                state: "error",
                code: "failed",
                message:
                  "Restore could not be confirmed. Refresh regions to check the saved choice.",
              }
            : { state: "idle" },
        undo:
          acknowledged && outcome.status === "acknowledged"
            ? {
                scope: context.scope,
                projectEpoch: context.projectEpoch,
                trackId: snapshot.occurrence.trackId,
                clipId: snapshot.occurrence.clipId,
                generation: snapshot.generation,
                expectedHeadId: outcome.historyHead,
                originOccurrenceKind,
              }
            : null,
      });
      return true;
    },
    finishUndo: (ticket: ClipBleedActionTicket): boolean => {
      if (!accepts(ticket) || ticket.kind !== "undo" || !snapshot) return false;
      context = contextFor(snapshot.occurrence)!;
      action = null;
      publish({
        ...snapshot,
        read: { state: "error", message: STALE_MESSAGE },
        selectedKey: null,
        action: { state: "idle" },
        undo: null,
      });
      return true;
    },
    failAction: (
      ticket: ClipBleedActionTicket,
      error: Extract<ClipBleedAction, { state: "error" }>,
    ): boolean => {
      if (!accepts(ticket) || !snapshot) return false;
      action = null;
      publish({
        ...snapshot,
        read:
          error.code === "STALE_TARGET"
            ? { state: "error", message: STALE_MESSAGE }
            : snapshot.read,
        selectedKey:
          error.code === "STALE_TARGET" ? null : snapshot.selectedKey,
        action: error,
        undo: null,
      });
      return true;
    },
    retire,
    dispose: () => {
      retire();
      unsubscribeStore();
      listeners.clear();
    },
  };
}

export const clipBleedSession = createClipBleedSession();
