/** Raw document-command HTTP transport; queue policy belongs to commandQueue. */
import { authHeaders } from "../sessionAuth";
import { reviewApiBase } from "../shareMode";

export async function hostFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: authHeaders(init?.headers),
  });
}

export function postGuestDocumentCommand(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${reviewApiBase(token)}/daw/document/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A host POST unanswered after this long is aborted and handled as a
 * transport failure: its record stays queued and replays idempotently.
 */
export const HOST_COMMAND_TIMEOUT_MS = 60_000;

export async function postHostDocumentCommand(
  projectPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Host document command timed out", "TimeoutError"),
      ),
    HOST_COMMAND_TIMEOUT_MS,
  );
  try {
    return await hostFetch(
      `/api/document/command?path=${encodeURIComponent(projectPath)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
