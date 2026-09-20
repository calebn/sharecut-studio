import { documentClientId } from "../utils/documentClient";

let appliedSeq = 0;

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

/** Skip Echo and own-HTTP; still apply peer / ExternalMutate at the current seq.

Hub overflow `resync` always applies, including own-client seq.
*/
export function shouldApplyDocumentEvent(msg: {
  type?: string;
  server_seq?: number;
  snapshot?: { server_seq?: number; resync?: boolean };
  command?: { client_id?: string };
}): boolean {
  if (msg.type === "Echo") {
    return false;
  }
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
