/** Raw document-command HTTP transport; queue policy belongs to commandQueue. */
import { authHeaders } from "../sessionAuth";
import { reviewApiBase } from "../shareMode";
import { withAbortTimeout } from "../utils/abortTimeout";
import { type ApiError, readApiFailure } from "../utils/apiError";

export async function hostFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

/**
 * A document-command POST whose response (headers and body) has not arrived
 * after this long is aborted and handled as a transport failure: its record
 * stays queued and replays with the same `(client_id, client_seq)`. The server
 * may still be running the original. `DocumentSyncService.submit` checks for a
 * retry under the workspace lock and the document write transaction, so the
 * replay waits for the original and then returns it as `idempotent`
 * (`tests/test_document_sync.py::test_concurrent_same_sequence_submits_apply_once`).
 */
export const DOCUMENT_COMMAND_TIMEOUT_MS = 60_000;

/** A document-command response, read in full within the timeout. */
export type DocumentCommandReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; failure: ApiError };

async function postDocumentCommand(
  send: (signal: AbortSignal) => Promise<Response>,
): Promise<DocumentCommandReply> {
  // Read the body inside the timeout: a stalled body must not hang.
  return withAbortTimeout(
    DOCUMENT_COMMAND_TIMEOUT_MS,
    "Document command timed out",
    async (signal): Promise<DocumentCommandReply> => {
      const res = await send(signal);
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          failure: await readApiFailure(res),
        };
      }
      return { ok: true, data: (await res.json()) as Record<string, unknown> };
    },
  );
}

export function postGuestDocumentCommand(
  token: string,
  body: Record<string, unknown>,
): Promise<DocumentCommandReply> {
  return postDocumentCommand((signal) =>
    fetch(`${reviewApiBase(token)}/daw/document/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
}

export function postHostDocumentCommand(
  projectPath: string,
  body: Record<string, unknown>,
): Promise<DocumentCommandReply> {
  return postDocumentCommand((signal) =>
    hostFetch(`/api/document/command?path=${encodeURIComponent(projectPath)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  );
}
