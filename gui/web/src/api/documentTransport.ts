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
 * after this long is aborted and handled as a transport failure. Ordinary
 * document-command records stay queued and replay with the same
 * `(client_id, client_seq)`. The server may still be running the original.
 * `DocumentSyncService.submit` checks for a retry under the workspace lock and
 * document write transaction, so replay waits for the original and then
 * returns it as `idempotent`
 * (`tests/test_document_sync.py::test_concurrent_same_sequence_submits_apply_once`).
 * History commands have an unknown outcome after timeout and are never replayed.
 */
export const DOCUMENT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Commands that legitimately run for minutes (Approve all re-checks speech and
 * pauses across the whole batch, 175 s on a real episode) get longer, so a long
 * but healthy batch is not cut off at one minute and shown as "Still sending".
 */
export const LONG_DOCUMENT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const LONG_DOCUMENT_COMMANDS = new Set([
  "ApproveEdits",
  "ApplySuggestedActions",
]);

function commandTimeoutMs(body: Record<string, unknown>): number {
  return typeof body.type === "string" && LONG_DOCUMENT_COMMANDS.has(body.type)
    ? LONG_DOCUMENT_COMMAND_TIMEOUT_MS
    : DOCUMENT_COMMAND_TIMEOUT_MS;
}

/** A document-command response, read in full within the timeout. */
export type DocumentCommandReply =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; failure: ApiError };

async function postDocumentCommand(
  send: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<DocumentCommandReply> {
  // Read the body inside the timeout: a stalled body must not hang.
  return withAbortTimeout(
    timeoutMs,
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
  return postDocumentCommand(
    (signal) =>
      fetch(`${reviewApiBase(token)}/daw/document/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    commandTimeoutMs(body),
  );
}

export function postHostDocumentCommand(
  projectPath: string,
  body: Record<string, unknown>,
): Promise<DocumentCommandReply> {
  return postDocumentCommand(
    (signal) =>
      hostFetch(
        `/api/document/command?path=${encodeURIComponent(projectPath)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
      ),
    commandTimeoutMs(body),
  );
}
