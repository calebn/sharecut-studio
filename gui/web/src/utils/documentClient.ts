/** Stable document-plane client identity + monotonic client_seq for the DAW tab. */

import { randomUuid } from "./randomUuid";

const CLIENT_ID_KEY = "daw_client_id";
const CLIENT_SEQ_KEY = "daw_document_client_seq";

export function documentClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = `viewer-${randomUuid().slice(0, 8)}`;
  sessionStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function nextDocumentClientSeq(): number {
  const raw = sessionStorage.getItem(CLIENT_SEQ_KEY);
  const previous = raw === null ? 0 : Number(raw);
  if (
    (raw !== null && !/^\d+$/.test(raw)) ||
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      "Cannot create this edit because its saved sequence is invalid.",
    );
  }
  const next = previous + 1;
  sessionStorage.setItem(CLIENT_SEQ_KEY, String(next));
  return next;
}

/** Peek next seq without consuming (for building a queued record). */
export function allocateDocumentClientSeq(): number {
  return nextDocumentClientSeq();
}

export function newCommandId(): string {
  return randomUuid().replace(/-/g, "");
}
