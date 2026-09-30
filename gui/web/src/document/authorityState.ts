import type { ProjectView } from "../types/project";

export type DocumentFileSignature = { mtime_ns: number; size: number };
export type DocumentScope = {
  readonly path: string;
  readonly generation: number;
};
export type DocumentPhase =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "recovering"; minimum: number };
export const documentAuthority = {
  path: "",
  generation: 0,
  seq: 0,
  token: null as string | null,
  file: null as DocumentFileSignature | null,
  project: null as ProjectView | null,
  phase: { kind: "starting" } as DocumentPhase,
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
    abort: new AbortController(),
  });
  return documentScope();
}
export function activateDocumentScope(path: string): DocumentScope {
  return path === documentAuthority.path
    ? documentScope()
    : resetDocumentAuthority(path);
}
