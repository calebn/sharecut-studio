/** Stable document-plane client identity + monotonic client_seq for the DAW tab. */

const CLIENT_ID_KEY = "daw_client_id";
const CLIENT_SEQ_KEY = "daw_document_client_seq";

export function documentClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = `viewer-${crypto.randomUUID().slice(0, 8)}`;
  sessionStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

export function nextDocumentClientSeq(): number {
  const raw = sessionStorage.getItem(CLIENT_SEQ_KEY);
  const next = (raw ? Number.parseInt(raw, 10) : 0) + 1;
  sessionStorage.setItem(CLIENT_SEQ_KEY, String(next));
  return next;
}

/** Peek next seq without consuming (for building a queued record). */
export function allocateDocumentClientSeq(): number {
  return nextDocumentClientSeq();
}

export function newCommandId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}
