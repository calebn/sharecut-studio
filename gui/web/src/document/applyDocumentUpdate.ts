import { loadDocumentState } from "../api/project";
import { isShareProjectKey } from "../shareMode";
import { useDawStore, zoomReclampPatch } from "../state/dawStore";
import { flushInbound } from "../sync/inboundQueue";
import type { ProjectView, TimelineComment } from "../types/project";
import { sessionSecOf } from "../utils/zoom";
import {
  activateDocumentScope,
  type DocumentScope,
  documentAuthority,
  documentScope,
  isCurrentDocumentScope,
} from "./authorityState";
import {
  currentDocumentSeq,
  noteDocumentFile,
  noteDocumentSeq,
} from "./cursor";
import { scheduleTranscriptDetailHydrate } from "./hydrateTranscriptDetail";
import { finishDocumentDraft, overlayDocumentDrafts } from "./pendingDrafts";
import { applyProjectionDelta, parseProjectionDelta } from "./projectionDelta";
import {
  type DocumentSnapshot,
  projectFromDocumentSnapshot,
  snapshotFromResult,
} from "./projectPatch";

let recovery: {
  scope: DocumentScope;
  promise: Promise<ProjectView | null>;
} | null = null;
function show(project: ProjectView): ProjectView {
  const displayed = overlayDocumentDrafts(project);
  useDawStore.setState((state) =>
    displayed === state.project
      ? state
      : {
          project: displayed,
          ...zoomReclampPatch(state, sessionSecOf({ project: displayed })),
        },
  );
  return displayed;
}
export function refreshDocumentDisplay(): void {
  if (
    documentAuthority.project &&
    documentAuthority.path === useDawStore.getState().projectPath
  )
    show(documentAuthority.project);
}
export function recoverDocument(
  minimum = currentDocumentSeq(),
  scope = documentScope(),
): Promise<ProjectView | null> {
  if (!isCurrentDocumentScope(scope) || !scope.path)
    return Promise.resolve(null);
  const current = documentAuthority.phase;
  documentAuthority.phase = {
    kind: "recovering",
    minimum: Math.max(
      minimum,
      current.kind === "recovering" ? current.minimum : currentDocumentSeq(),
    ),
  };
  if (recovery && isCurrentDocumentScope(recovery.scope))
    return recovery.promise;
  const signal = documentAuthority.abort.signal;
  const promise = (async () => {
    while (isCurrentDocumentScope(scope) && !signal.aborted) {
      const snap = await loadDocumentState(
        scope.path,
        isShareProjectKey(scope.path) ? "shell" : "full",
        signal,
      );
      if (!isCurrentDocumentScope(scope)) return null;
      const phase = documentAuthority.phase;
      if (phase.kind !== "recovering") return useDawStore.getState().project;
      if (!snap.resync && Number(snap.server_seq) >= phase.minimum)
        return applyDocumentSnapshot(snap, { scope });
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  })();
  recovery = { scope, promise };
  void promise
    .catch(() => undefined)
    .finally(() => {
      if (recovery?.promise === promise) recovery = null;
    });
  return promise;
}
function invalidate(minimum: number, scope: DocumentScope): ProjectView | null {
  void recoverDocument(minimum, scope).catch(() => undefined);
  return useDawStore.getState().project;
}
function shellBasis(project: ProjectView): ProjectView {
  if (!project.transcript) return project;
  return {
    ...project,
    transcript: {
      ...project.transcript,
      utterances: project.transcript.utterances.map((row) => {
        const { words: _words, ...header } = row;
        return header;
      }),
    },
    meta: {
      ...project.meta,
      hydration: { ...project.meta.hydration, transcript_words: false },
    },
  };
}
export function applyDocumentSnapshot(
  snap: DocumentSnapshot,
  opts?: {
    force?: boolean;
    commandClientId?: string;
    scope?: DocumentScope;
    hydrationSeq?: number;
  },
): ProjectView | null {
  const scope =
    opts?.scope ?? activateDocumentScope(useDawStore.getState().projectPath);
  if (
    !isCurrentDocumentScope(scope) ||
    (scope.path && useDawStore.getState().projectPath !== scope.path)
  )
    return useDawStore.getState().project;
  if (snap.server_seq === undefined) {
    const next = projectFromDocumentSnapshot(
      useDawStore.getState().project,
      snap,
    );
    return next ? show(next) : null;
  }
  const seq = snap.server_seq;
  if (!Number.isSafeInteger(seq) || seq < 0)
    return invalidate(currentDocumentSeq(), scope);
  if (seq < currentDocumentSeq()) return useDawStore.getState().project;
  if (
    opts?.hydrationSeq !== undefined &&
    (opts.hydrationSeq !== currentDocumentSeq() || seq !== opts.hydrationSeq)
  )
    return useDawStore.getState().project;
  if (snap.resync) return invalidate(seq, scope);
  if (
    opts?.hydrationSeq !== undefined &&
    snap.state_token !== documentAuthority.token
  )
    return invalidate(seq, scope);
  const previous = documentAuthority.project;
  let next: ProjectView | null;
  if (snap.delta !== undefined) {
    if (
      seq <= currentDocumentSeq() &&
      documentAuthority.phase.kind !== "starting"
    )
      return useDawStore.getState().project;
    try {
      const delta = parseProjectionDelta(snap.delta);
      if (
        documentAuthority.phase.kind !== "ready" ||
        !previous ||
        delta.base_seq !== currentDocumentSeq() ||
        delta.base_token !== documentAuthority.token ||
        seq !== delta.base_seq + 1
      )
        return invalidate(seq, scope);
      if (
        snap.file_before &&
        documentAuthority.file &&
        (snap.file_before.mtime_ns !== documentAuthority.file.mtime_ns ||
          snap.file_before.size !== documentAuthority.file.size)
      )
        return invalidate(seq, scope);
      const basis =
        delta.projection === "shell" ? shellBasis(previous) : previous;
      next = projectFromDocumentSnapshot(previous, {
        project: applyProjectionDelta(basis, delta),
      });
    } catch {
      return invalidate(seq, scope);
    }
  } else {
    const phase = documentAuthority.phase;
    if (phase.kind === "recovering" && seq < phase.minimum)
      return useDawStore.getState().project;
    if (
      !snap.project &&
      (phase.kind !== "ready" || seq !== currentDocumentSeq())
    )
      return invalidate(seq, scope);
    next = projectFromDocumentSnapshot(previous, snap);
  }
  if (!next) return invalidate(seq, scope);
  documentAuthority.token = snap.state_token ?? null;
  documentAuthority.project = next;
  documentAuthority.phase = { kind: "ready" };
  noteDocumentSeq(seq);
  noteDocumentFile(snap);
  const displayed = show(next);
  scheduleTranscriptDetailHydrate(previous, next);
  return displayed;
}

export async function refreshDocumentProject(
  path: string,
): Promise<ProjectView> {
  if (useDawStore.getState().projectPath !== path)
    throw new Error("Project changed during refresh");
  const scope = activateDocumentScope(path);
  const snap = await loadDocumentState(path);
  if (!isCurrentDocumentScope(scope))
    throw new Error("Project changed during refresh");
  const project = applyDocumentSnapshot(snap, { scope });
  if (!project) throw new Error("Document refresh has no project");
  return project;
}

export function mergeReturnedComment(comment: TimelineComment): void {
  const previous = useDawStore.getState().project;
  if (!previous) return;
  const comments = [...previous.comments];
  const index = comments.findIndex((value) => value.id === comment.id);
  if (index < 0) comments.push(comment);
  else comments[index] = comment;
  applyDocumentSnapshot({ comments }, { force: true });
}
export function mergeGuestActionDone(
  commentId: string,
  actionId: string,
  done: boolean,
): void {
  const previous = useDawStore.getState().project;
  if (!previous) return;
  applyDocumentSnapshot(
    {
      comments: previous.comments.map((comment) =>
        comment.id !== commentId
          ? comment
          : {
              ...comment,
              action_items: comment.action_items.map((action) =>
                action.id === actionId ? { ...action, done } : action,
              ),
            },
      ),
    },
    { force: true },
  );
}
export { applyDocumentSnapshot as applyDocumentUpdate };
export function applyDocumentResult(
  result: Record<string, unknown>,
  scope?: DocumentScope,
): ProjectView | null {
  flushInbound();
  if (scope && !isCurrentDocumentScope(scope))
    return useDawStore.getState().project;
  const command = result.command;
  if (
    command &&
    typeof command === "object" &&
    "command_id" in command &&
    typeof command.command_id === "string"
  )
    finishDocumentDraft(command.command_id);
  const snap = snapshotFromResult(result);
  if (!snap) return useDawStore.getState().project;
  const next = applyDocumentSnapshot(snap, { scope });
  refreshDocumentDisplay();
  return next;
}
export { currentDocumentSeq, noteDocumentSeq };
