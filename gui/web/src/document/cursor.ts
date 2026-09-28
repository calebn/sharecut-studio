import { documentClientId } from "../utils/documentClient";
import { jsonEqual } from "../utils/jsonEqual";

/** Identity of the episode.project.json a document snapshot was built from (#657). */
export type DocumentFileSignature = { mtime_ns: number; size: number };

let appliedSeq = 0;
let appliedFile: DocumentFileSignature | null = null;

export function noteDocumentSeq(seq: number): void {
  if (seq > appliedSeq) {
    appliedSeq = seq;
  }
}

export function currentDocumentSeq(): number {
  return appliedSeq;
}

export function resetDocumentSeq(): void {
  appliedSeq = 0;
  appliedFile = null;
}

export function resetDocumentSeqForTests(): void {
  resetDocumentSeq();
}

export function eventServerSeq(msg: {
  server_seq?: number;
  snapshot?: { server_seq?: number };
}): number {
  return Number(msg.snapshot?.server_seq ?? msg.server_seq ?? 0);
}

/** Skip stale seq and own-HTTP; still apply peers at the current seq. ExternalMutate
(MCP / landing / REST comments) arrives at the newer seq its journal row assigns (#661).

Hub overflow `resync` always applies, including own-client seq.
*/
export function shouldApplyDocumentEvent(msg: {
  server_seq?: number;
  snapshot?: { server_seq?: number; resync?: boolean };
  command?: { client_id?: string };
}): boolean {
  if (msg.snapshot?.resync) {
    return true;
  }
  const seq = eventServerSeq(msg);
  if (seq > 0 && seq < appliedSeq) {
    return false;
  }
  const ownId = msg.command?.client_id;
  if (ownId && seq > 0 && seq <= appliedSeq && ownId === documentClientId()) {
    return false;
  }
  return true;
}

/** After mtime/size change: refetch unless WS already moved past meta.server_seq. */
export function shouldApplyPollSnapshot(
  metaSeq: number,
  appliedSeqValue: number,
): boolean {
  return !(metaSeq > 0 && appliedSeqValue > metaSeq);
}

function wireFile(value: unknown): DocumentFileSignature | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { mtime_ns?: unknown }).mtime_ns === "number" &&
    typeof (value as { size?: unknown }).size === "number"
  ) {
    const v = value as { mtime_ns: number; size: number };
    return { mtime_ns: v.mtime_ns, size: v.size };
  }
  return null;
}

/** Exact field match. Epoch `mtime_ns` (~1.8e18) exceeds 2^53, so JSON.parse keeps
it only to ~256 ns on both the socket and the meta path: the same file always
matches, but two writes of equal `size` whose true mtimes fall within one ~256 ns
step would match too. Saves are never that close, and `useFileMetaPoll` already
compares mtime at this precision. */
function sameFile(
  a: DocumentFileSignature | null,
  b: DocumentFileSignature | null,
): boolean {
  return a !== null && b !== null && jsonEqual(a, b);
}

/** Track the file identity this client has applied so far — from the document
socket or its own command's HTTP result (#657).

Adopts `snap.file` outright when the snapshot carries a whole `project`
(shell/full — the same content a poll GET returns). Otherwise it only
advances when `snap.file_before` chains onto the file already held, so a
patch this client never saw the predecessor of does not silently claim a
newer file. A snapshot whose file is the one already held leaves it unchanged.
`resync` or a missing/invalid `file` clears it to unknown. */
export function noteDocumentFile(snap: {
  file?: unknown;
  file_before?: unknown;
  project?: unknown;
  resync?: boolean;
}): void {
  const file = wireFile(snap.file);
  if (snap.resync || !file) {
    appliedFile = null;
    return;
  }
  if (sameFile(file, appliedFile)) {
    // The same file announced again (own HTTP result and its WS echo, in either
    // order, or an idempotent retry): already held.
    return;
  }
  if (snap.project) {
    appliedFile = file;
    return;
  }
  const before = wireFile(snap.file_before);
  appliedFile = sameFile(before, appliedFile) ? file : null;
}

/** Record the file identity a poll GET was applied at (#657). */
export function notePolledDocumentFile(meta: {
  mtime_ns: number;
  size?: number;
}): void {
  appliedFile =
    meta.size === undefined
      ? null
      : { mtime_ns: meta.mtime_ns, size: meta.size };
}

/** True when the document socket already delivered exactly this meta file at
this seq or later, so `useProjectPoll` can skip its GET (#657).
Document twin of `sessionPollAlreadyApplied` in `session/dedupe.ts`; keep the
two in step. A missing `server_seq` counts as 0 here because the file-identity
check still guards the skip. */
export function pollSnapshotAlreadyApplied(meta: {
  mtime_ns: number;
  size?: number;
  server_seq?: number;
}): boolean {
  return (
    appliedFile !== null &&
    (meta.server_seq ?? 0) <= appliedSeq &&
    sameFile(appliedFile, wireFile(meta))
  );
}
