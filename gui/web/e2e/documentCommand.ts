import { expect, type Page } from "@playwright/test";
import { e2eProjectPath } from "./env";

export async function postDocumentCommand(
  page: Page,
  clientId: string,
  type: string,
  payload: Record<string, unknown>,
  projectPath = e2eProjectPath,
): Promise<void> {
  const res = await page.request.post(
    `/api/document/command?path=${encodeURIComponent(projectPath)}`,
    { data: { type, payload, client_id: clientId, role: "viewer" } },
  );
  expect(res.ok(), `${type} command failed: ${await res.text()}`).toBe(true);
}

/** The history head the project holds now (`history.head_id`). */
export async function historyHead(
  page: Page,
  projectPath = e2eProjectPath,
): Promise<string> {
  const res = await page.request.get(
    `/api/document/comments?path=${encodeURIComponent(projectPath)}`,
  );
  expect(res.ok(), `history head: ${await res.text()}`).toBe(true);
  return (await res.json()).history.head_id;
}

/**
 * Undo or redo as a client that saw the latest head. The document plane
 * requires `expected_head_id`, so a test driver reads the head first.
 */
export async function postHistoryMove(
  page: Page,
  clientId: string,
  type: "UndoHistory" | "RedoHistory",
  projectPath = e2eProjectPath,
): Promise<void> {
  await postDocumentCommand(
    page,
    clientId,
    type,
    { rerender: false, expected_head_id: await historyHead(page, projectPath) },
    projectPath,
  );
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
