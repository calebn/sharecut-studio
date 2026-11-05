import fs from "node:fs";
import { expect, type Page, type Response, test } from "@playwright/test";
import { historyHead, postDocumentCommand } from "./documentCommand";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";

/**
 * Undo is guarded by the history head the person saw (#1031): the tab's own
 * fast presses chain through each reply's head, and a guest is held to the
 * head it was sent, so neither reverts an edit it never saw.
 */

const AGENT = "e2e-history-agent";

function chapterTitles(projectPath: string): string[] {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  return (data.editorial?.chapters ?? data.chapters ?? []).map(
    (chapter: { title: string }) => chapter.title,
  );
}

async function addChapter(
  page: Page,
  projectPath: string,
  title: string,
  time: number,
): Promise<void> {
  await postDocumentCommand(
    page,
    AGENT,
    "AddChapter",
    { time, title },
    projectPath,
  );
}

function isHistoryMove(response: Response): boolean {
  if (response.request().method() !== "POST") return false;
  if (!/\/document\/command/.test(response.url())) return false;
  const type = response.request().postDataJSON()?.type;
  return type === "UndoHistory" || type === "RedoHistory";
}

test("two fast Mod+Z presses undo two changes, the second expecting where the first landed", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    await addChapter(page, projectPath, "Rapid one", 5);
    await addChapter(page, projectPath, "Rapid two", 9);
    await expect(page.getByLabel("Chapter Rapid two")).toBeVisible();

    const moves: Response[] = [];
    page.on("response", (response) => {
      if (isHistoryMove(response)) moves.push(response);
    });
    await page.locator(".timeline-scroll").click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Z");
    await page.keyboard.press("ControlOrMeta+Z");

    await expect.poll(() => moves.length).toBe(2);
    expect(moves.map((response) => response.status())).toEqual([200, 200]);
    const first = await moves[0].json();
    expect(moves[1].request().postDataJSON().payload.expected_head_id).toBe(
      first.history_head_id,
    );
    await expect
      .poll(() => chapterTitles(projectPath))
      .not.toContain("Rapid one");
    await expect(
      page.getByText("Can't undo: the project changed since", {
        exact: false,
      }),
    ).toHaveCount(0);
  });
});

test("a guest editor's undo names the head it was sent, and a stale one is refused", async ({
  browser,
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    const token = await createReviewShare(page, projectPath, "editor");
    const guestContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      const guest = await guestContext.newPage();
      await openGuestShare(guest, token);
      const seenByGuest = await historyHead(page, projectPath);

      // An agent edit lands; a guest undo still naming the old head is refused.
      await addChapter(page, projectPath, "Agent chapter", 7);
      const stale = await guest.request.post(
        `/api/review/${token}/daw/document/command`,
        {
          data: {
            type: "UndoHistory",
            payload: { rerender: false, expected_head_id: seenByGuest },
            client_id: "e2e-stale-guest",
            client_seq: 1,
            role: "guest",
          },
        },
      );
      expect(stale.status()).toBe(409);
      expect(stale.headers()["x-sharecut-error-code"]).toBe("history_stale");
      expect(chapterTitles(projectPath)).toContain("Agent chapter");

      // Once the guest has received it, the guest's own Mod+Z sends that head.
      await expect(guest.getByLabel("Chapter Agent chapter")).toBeVisible();
      const current = await historyHead(page, projectPath);
      const undo = guest.waitForResponse(isHistoryMove);
      await guest
        .locator(".timeline-scroll")
        .click({ position: { x: 4, y: 4 } });
      await guest.keyboard.press("Escape");
      await guest.keyboard.press("ControlOrMeta+Z");
      const response = await undo;
      expect(response.request().postDataJSON().payload.expected_head_id).toBe(
        current,
      );
      expect(response.status()).toBe(200);
      await expect
        .poll(() => chapterTitles(projectPath))
        .not.toContain("Agent chapter");
    } finally {
      await guestContext.close();
    }
  });
});
