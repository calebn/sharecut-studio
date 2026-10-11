import type { HistoryEntryId, ProjectView } from "../types/project";

export type DocumentFileSignature = { mtime_ns: number; size: number };
export type DocumentScope = {
  readonly path: string;
  readonly generation: number;
};
export type DocumentPhase =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "recovering"; minimum: number };
export type OwnCommandHeadObservation = {
  readonly seq: number;
  readonly head: HistoryEntryId;
  readonly displayedFrom: HistoryEntryId | null;
};
export const documentAuthority = {
  path: "",
  generation: 0,
  seq: 0,
  token: null as string | null,
  file: null as DocumentFileSignature | null,
  project: null as ProjectView | null,
  phase: { kind: "starting" } as DocumentPhase,
  ownCommandHead: null as OwnCommandHeadObservation | null,
  abort: new AbortController(),
};
export function documentScope(): DocumentScope {
  return {
    path: documentAuthority.path,
    generation: documentAuthority.generation,
  };
}
export function isCurrentDocumentScope(scope: DocumentScope): boolean {
  return (
    scope.path === documentAuthority.path &&
    scope.generation === documentAuthority.generation
  );
}
export function resetDocumentAuthority(path = ""): DocumentScope {
  documentAuthority.abort.abort();
  Object.assign(documentAuthority, {
    path,
    generation: documentAuthority.generation + 1,
    seq: 0,
    token: null,
    file: null,
    project: null,
    phase: { kind: "starting" },
    ownCommandHead: null,
    abort: new AbortController(),
  });
  return documentScope();
}
export function activateDocumentScope(path: string): DocumentScope {
  return path === documentAuthority.path
    ? documentScope()
    : resetDocumentAuthority(path);
}

export function noteOwnCommandHead(
  scope: DocumentScope,
  reply: OwnCommandHeadObservation,
): void {
  if (
    !isCurrentDocumentScope(scope) ||
    reply.seq <= documentAuthority.seq ||
    (documentAuthority.phase.kind === "recovering" &&
      reply.seq < documentAuthority.phase.minimum)
  )
    return;
  const previous = documentAuthority.ownCommandHead;
  if (previous && reply.seq <= previous.seq) {
    if (reply.seq === previous.seq && reply.head !== previous.head)
      documentAuthority.ownCommandHead = null;
    return;
  }
  documentAuthority.ownCommandHead = { ...reply };
}

export function ownCommandHead(
  scope: DocumentScope,
  shown: HistoryEntryId | null,
): OwnCommandHeadObservation | null {
  const observation = documentAuthority.ownCommandHead;
  return observation &&
    isCurrentDocumentScope(scope) &&
    documentAuthority.seq < observation.seq &&
    (documentAuthority.phase.kind !== "recovering" ||
      documentAuthority.phase.minimum <= observation.seq) &&
    shown === observation.displayedFrom
    ? observation
    : null;
}

export function retireOwnCommandHead(
  observation: OwnCommandHeadObservation | null,
): void {
  if (documentAuthority.ownCommandHead === observation)
    documentAuthority.ownCommandHead = null;
}
