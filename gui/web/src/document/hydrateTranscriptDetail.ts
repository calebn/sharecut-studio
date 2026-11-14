import { loadDocumentState } from "../api/project";
import { readsTranscriptWords } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import { applyDocumentSnapshot, recoverDocument } from "./applyDocumentUpdate";
import {
  activateDocumentScope,
  type DocumentScope,
  documentAuthority,
  isCurrentDocumentScope,
} from "./authorityState";
import { currentDocumentSeq } from "./cursor";

type RequestKey = {
  path: string;
  generation: number;
  seq: number;
  token: string | null;
};

type Attempt = {
  id: number;
  key: RequestKey;
  scope: DocumentScope;
  controller: AbortController;
  detachScope: () => void;
};

export type TranscriptDetailSnapshot =
  | { kind: "idle" }
  | { kind: "pending"; attempt: number }
  | { kind: "failed"; attempt: number; recovering: boolean };

type ActiveState =
  | { kind: "idle" }
  | { kind: "pending"; request: Attempt }
  | { kind: "failed"; request: Attempt; recovering: boolean };

const IDLE: TranscriptDetailSnapshot = Object.freeze({ kind: "idle" });
let active: ActiveState = { kind: "idle" };
let snapshot: TranscriptDetailSnapshot = IDLE;
let nextAttempt = 0;
const listeners = new Set<() => void>();

function publish(next: ActiveState): void {
  active = next;
  snapshot =
    next.kind === "idle"
      ? IDLE
      : Object.freeze(
          next.kind === "pending"
            ? { kind: "pending", attempt: next.request.id }
            : {
                kind: "failed",
                attempt: next.request.id,
                recovering: next.recovering,
              },
        );
  for (const listener of listeners) listener();
}

function retire(publishIdle = true): void {
  if (active.kind !== "idle") {
    const previous = active.request;
    previous.controller.abort();
    previous.detachScope();
    if (publishIdle) publish({ kind: "idle" });
  }
}

function sameKey(a: RequestKey, b: RequestKey): boolean {
  return (
    a.path === b.path &&
    a.generation === b.generation &&
    a.seq === b.seq &&
    a.token === b.token
  );
}

function requestStillCurrent(request: Attempt): boolean {
  const { projectPath } = useDawStore.getState();
  const currentProject = useDawStore.getState().project;
  return (
    !request.controller.signal.aborted &&
    isCurrentDocumentScope(request.scope) &&
    projectPath === request.key.path &&
    needsTranscriptDetailHydrate(
      currentProject,
      readsTranscriptWords(
        projectPath,
        useDawStore.getState().shareTranscriptWords,
      ),
    )
  );
}

function isActiveAttempt(request: Attempt): boolean {
  return active.kind !== "idle" && active.request === request;
}

function replaceDriftedRequest({ key, scope }: Attempt): void {
  beginRequest(
    { ...key, seq: currentDocumentSeq(), token: documentAuthority.token },
    scope,
    active.kind === "failed",
  );
}

function beginRequest(
  key: RequestKey,
  scope: DocumentScope,
  recovering = false,
): Attempt {
  retire(!recovering);
  const controller = new AbortController();
  const request: Attempt = {
    id: ++nextAttempt,
    key,
    scope,
    controller,
    detachScope: () => undefined,
  };
  const authoritySignal = documentAuthority.abort.signal;
  const retireOnScopeAbort = () => {
    if (active.kind !== "idle" && active.request === request) retire();
  };
  authoritySignal.addEventListener("abort", retireOnScopeAbort, { once: true });
  request.detachScope = () =>
    authoritySignal.removeEventListener("abort", retireOnScopeAbort);
  publish(
    recovering
      ? { kind: "failed", request, recovering: true }
      : { kind: "pending", request },
  );

  void loadDocumentState(key.path, "detail", controller.signal)
    .then((detail) => {
      if (
        (active.kind !== "pending" &&
          !(active.kind === "failed" && active.recovering)) ||
        active.request !== request
      )
        return;
      if (!requestStillCurrent(request)) {
        retire();
        return;
      }
      if (
        currentDocumentSeq() !== key.seq ||
        detail.server_seq !== key.seq ||
        documentAuthority.token !== key.token
      ) {
        replaceDriftedRequest(request);
        return;
      }
      applyDocumentSnapshot(detail, { scope, hydrationSeq: key.seq });
      if (
        !isActiveAttempt(request) ||
        (active.kind === "failed" && !active.recovering)
      )
        return;
      if (documentAuthority.phase.kind === "recovering") {
        // A drifted token sent the document to a shell recovery: the detail is
        // being redone, not refused: the request stays pending and the shell
        // that lands reschedules it. Only a recovery that fails is a failure
        // the guest can retry.
        void recoverDocument().catch(() => {
          if (isActiveAttempt(request))
            publish({ kind: "failed", request, recovering: false });
        });
        return;
      }
      const current = useDawStore.getState().project;
      if (
        needsTranscriptDetailHydrate(
          current,
          readsTranscriptWords(
            key.path,
            useDawStore.getState().shareTranscriptWords,
          ),
        )
      ) {
        publish({ kind: "failed", request, recovering: false });
      } else {
        request.detachScope();
        publish({ kind: "idle" });
      }
    })
    .catch(() => {
      if (
        (active.kind !== "pending" &&
          !(active.kind === "failed" && active.recovering)) ||
        active.request !== request
      )
        return;
      if (!requestStillCurrent(request)) {
        retire();
        return;
      }
      if (
        currentDocumentSeq() !== key.seq ||
        documentAuthority.token !== key.token
      ) {
        replaceDriftedRequest(request);
      } else {
        publish({ kind: "failed", request, recovering: false });
      }
    })
    .finally(() => {
      if (active.kind === "idle" || active.request !== request)
        request.detachScope();
    });
  return request;
}

export function needsTranscriptDetailHydrate(
  next: ProjectView | null,
  reads: boolean,
): boolean {
  return reads && next?.meta?.hydration?.transcript_words === false;
}

export function subscribeTranscriptDetail(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function transcriptDetailSnapshot(): TranscriptDetailSnapshot {
  return snapshot;
}

export function transcriptDetailStateFor(
  path: string,
  scope: DocumentScope,
  seq: number,
  token: string | null,
): TranscriptDetailSnapshot {
  if (active.kind === "idle") return IDLE;
  const key = active.request.key;
  if (
    key.path !== path ||
    key.generation !== scope.generation ||
    key.seq !== seq ||
    key.token !== token
  )
    return IDLE;
  return snapshot;
}

export function retryTranscriptDetail(attemptId: number): void {
  if (
    active.kind === "idle" ||
    active.request.id !== attemptId ||
    (active.kind === "failed" && active.recovering) ||
    !requestStillCurrent(active.request) ||
    currentDocumentSeq() !== active.request.key.seq ||
    documentAuthority.token !== active.request.key.token
  )
    return;
  const preserveCover = active.kind === "failed";
  const { key, scope } = active.request;
  beginRequest(key, scope, preserveCover);
}

/** Re-fetch DETAIL words after overlay leaves `transcript_words` incomplete. */
export function scheduleTranscriptDetailHydrate(
  next: ProjectView | null,
): void {
  const { projectPath: path, shareTranscriptWords } = useDawStore.getState();
  if (
    !path ||
    !needsTranscriptDetailHydrate(
      next,
      readsTranscriptWords(path, shareTranscriptWords),
    )
  ) {
    retire();
    return;
  }
  const scope = activateDocumentScope(path);
  const key: RequestKey = {
    path,
    generation: scope.generation,
    seq: currentDocumentSeq(),
    token: documentAuthority.token,
  };
  if (
    active.kind !== "idle" &&
    sameKey(active.request.key, key) &&
    (active.kind === "pending" || active.recovering)
  )
    return;
  beginRequest(key, scope, active.kind === "failed");
}
