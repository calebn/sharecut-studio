import { expect, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";

/** POST one document command for the suite project and assert it applied. */
export async function postDocumentCommand(
  page: Page,
  clientId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.post(
    `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
    { data: { type, payload, client_id: clientId, role: "viewer" } },
  );
  expect(res.ok()).toBe(true);
}

/**
 * Waive the transcript-refine gate before an edit. The gate may be off in
 * this environment, so the response is not checked.
 */
export async function waiveRefineGate(
  page: Page,
  reason: string,
): Promise<void> {
  await page.request.post("/api/transcript/refine/waive", {
    data: { path: e2eProjectPath, reason },
  });
}
