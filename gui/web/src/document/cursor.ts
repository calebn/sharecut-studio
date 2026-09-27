import { documentClientId } from "../utils/documentClient";

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

/** Skip stale seq and own-HTTP; still apply peer / ExternalMutate at the current seq.

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

/** mtime_ns exceeds 2^53; both sides round-trip through JSON.parse, so an exact
match here means the same double on both ends, not a false collision from
float rounding. */
function sameFile(
  a: DocumentFileSignature | null,
  b: DocumentFileSignature | null,
): boolean {
  return (
    a !== null && b !== null && a.mtime_ns === b.mtime_ns && a.size === b.size
  );
}

/** Track the file identity the document socket has delivered so far (#657).

Adopts `snap.file` outright when the snapshot carries a whole `project`
(shell/full — the same content a poll GET returns). Otherwise it only
advances when `snap.file_before` chains onto the file already held, so a
patch this client never saw the predecessor of does not silently claim a
newer file. `resync` or a missing/invalid `file` clears it to unknown. */
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
this seq or later, so `useProjectPoll` can skip its GET (#657). */
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
