import { expect, type Page } from "@playwright/test";

/** Record-share room as returned by `POST /api/shares/record`. */
export type RecordRoom = {
  session_id: string;
  guest: { token: string };
  producer: { token: string };
};

/**
 * Opt a page into the in-app E2E hooks. They only activate when the page URL
 * also carries `?e2e=1` (see `src/record/monitor/e2eHook.ts`).
 */
export async function markSharecutE2e(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __SHARECUT_E2E?: boolean }).__SHARECUT_E2E = true;
  });
}

/** Create a record room for `projectPath` through the host's API session. */
export async function createRecordRoom(
  host: Page,
  projectPath: string,
): Promise<RecordRoom> {
  const created = await host.request.post("/api/shares/record", {
    data: { path: projectPath },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const body = (await created.json()) as { room: RecordRoom };
  return body.room;
}

/** Path of the E2E-enabled `/rec/<token>` landing for a guest or producer. */
export function recordLinkPath(token: string): string {
  return `/rec/${encodeURIComponent(token)}?e2e=1`;
}

/** Navigate a guest or producer page to its record link. */
export async function openRecordLink(page: Page, token: string): Promise<void> {
  await page.goto(recordLinkPath(token));
}
