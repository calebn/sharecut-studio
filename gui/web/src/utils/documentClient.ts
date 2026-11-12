import { createMonotonicSeq } from "./monotonicSeq";
import { randomUuid } from "./randomUuid";
import { getTab, setTab } from "./tabStorage";

const documentSeq = createMonotonicSeq("daw_document_client_seq", {
  onCorrupt: "throw",
});

const CLIENT_ID_KEY = "daw_client_id";

let unpersistedId: string | undefined;

export function documentClientId(): string {
  const existing = getTab(CLIENT_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = unpersistedId ?? `viewer-${randomUuid().slice(0, 8)}`;
  if (!setTab(CLIENT_ID_KEY, id)) {
    unpersistedId = id;
  }
  return id;
}

export function nextDocumentClientSeq(): number {
  return documentSeq.next();
}

export function newCommandId(): string {
  return randomUuid().replace(/-/g, "");
}
