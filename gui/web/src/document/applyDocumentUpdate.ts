import { useDawStore } from "../state/dawStore";
import type { ProjectView, TimelineComment } from "../types/project";
import {
  currentDocumentSeq,
  noteDocumentSeq,
  shouldApplyDocumentEvent,
} from "./cursor";
import { scheduleTranscriptDetailHydrate } from "./hydrateTranscriptDetail";
import {
  type DocumentSnapshot,
  projectFromDocumentSnapshot,
  snapshotFromResult,
} from "./projectPatch";

export function applyDocumentSnapshot(
  snap: DocumentSnapshot,
  opts?: { force?: boolean; commandClientId?: string },
): ProjectView | null {
  const seq = Number(snap.server_seq ?? 0);
  if (
    !opts?.force &&
    !shouldApplyDocumentEvent({
      snapshot: snap,
      server_seq: seq,
      command: { client_id: opts?.commandClientId },
    })
  ) {
    if (seq > 0) {
      noteDocumentSeq(seq);
    }
    return useDawStore.getState().project;
  }
  let previous: ProjectView | null = null;
  let applied: ProjectView | null = null;
  useDawStore.setState((state) => {
    previous = state.project;
    const next = projectFromDocumentSnapshot(state.project, snap);
    applied = next;
    if (!next) {
      return state;
    }
    return { project: next };
  });
  if (applied) {
    useDawStore.getState().reclampZoomForDuration();
  }
  if (seq > 0) {
    noteDocumentSeq(seq);
  }
  scheduleTranscriptDetailHydrate(previous, applied);
  return applied;
}

export async function applyDocumentSnapshotWithResync(
  snap: DocumentSnapshot,
  loadShell: () => Promise<ProjectView>,
  opts?: { force?: boolean; commandClientId?: string },
): Promise<ProjectView | null> {
  if (snap.resync) {
    const project = await loadShell();
    return applyDocumentSnapshot(
      {
        project,
        server_seq: snap.server_seq,
        comments: snap.comments,
        history: snap.history,
      },
      { force: true, commandClientId: opts?.commandClientId },
    );
  }
  return applyDocumentSnapshot(snap, opts);
}

export function mergeReturnedComment(comment: TimelineComment): void {
  const prev = useDawStore.getState().project;
  if (!prev) {
    return;
  }
  const comments = [...(prev.comments ?? [])];
  const i = comments.findIndex((c) => c.id === comment.id);
  if (i >= 0) {
    comments[i] = comment;
  } else {
    comments.push(comment);
  }
  applyDocumentSnapshot({ comments }, { force: true });
}

export function mergeGuestActionDone(
  commentId: string,
  actionId: string,
  done: boolean,
): void {
  const prev = useDawStore.getState().project;
  if (!prev) {
    return;
  }
  const comments = (prev.comments ?? []).map((c) => {
    if (c.id !== commentId) {
      return c;
    }
    return {
      ...c,
      action_items: c.action_items.map((a) =>
        a.id === actionId ? { ...a, done } : a,
      ),
    };
  });
  applyDocumentSnapshot({ comments }, { force: true });
}

export { applyDocumentSnapshot as applyDocumentUpdate };

export function applyDocumentResult(
  result: Record<string, unknown>,
): ProjectView | null {
  const snap = snapshotFromResult(result);
  if (!snap) {
    return useDawStore.getState().project;
  }
  const cmd = result.command;
  const clientId =
    cmd && typeof cmd === "object" && "client_id" in cmd
      ? String((cmd as { client_id?: string }).client_id ?? "")
      : undefined;
  return applyDocumentSnapshot(snap, { commandClientId: clientId });
}

export { currentDocumentSeq, noteDocumentSeq };
