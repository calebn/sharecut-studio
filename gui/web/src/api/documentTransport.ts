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

export function postHostDocumentCommand(
  projectPath: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return hostFetch(
    `/api/document/command?path=${encodeURIComponent(projectPath)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}
