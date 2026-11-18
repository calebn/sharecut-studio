import fs from "node:fs";
import { expect, type Page, type Response, test } from "@playwright/test";
import { historyHead, postDocumentCommand } from "./documentCommand";
import { expectFeedback } from "./feedback";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { goToStage, openProjectDialog } from "./stageNav";

/**
 * An Editor's Undo and Redo take back only the Editor's own step. The header
 * button, the palette row and Mod+Z answer the same at every point, a refusal
 * is told in words and never filed as a conflict, and nothing of the host's
 * disappears.
 */

const UNDO_SENTENCE =
  "There is nothing of yours to undo. The latest change is someone else's.";
const REDO_SENTENCE =
  "There is nothing of yours to redo. Redo brings back only what you undid.";

function chapterTitles(projectPath: string): string[] {
  const data = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  return (data.editorial?.chapters ?? data.chapters ?? []).map(
    (chapter: { title: string }) => chapter.title,
  );
}

function isHistoryMove(response: Response): boolean {
  if (response.request().method() !== "POST") return false;
  if (!/\/daw\/document\/command/.test(response.url())) return false;
  const type = response.request().postDataJSON()?.type;
  return type === "UndoHistory" || type === "RedoHistory";
}

async function guestChapter(
  guest: Page,
  token: string,
  title: string,
  time: number,
  seq: number,
): Promise<void> {
  const reply = await guest.request.post(
    `/api/review/${token}/daw/document/command`,
    {
      data: {
        type: "AddChapter",
        payload: { title, time },
        client_id: "e2e-own-step",
        client_seq: seq,
        role: "guest",
      },
    },
  );
  expect(reply.ok(), await reply.text()).toBe(true);
  await expect(guest.getByLabel(`Chapter ${title}`)).toBeVisible();
}

async function paletteRowDisabled(
  guest: Page,
  label: "Undo" | "Redo",
): Promise<boolean> {
  await openProjectDialog(guest, "palette");
  const search = guest.getByRole("combobox", { name: "Search commands" });
  await search.fill(label);
  const row = guest.getByRole("option", {
    name: new RegExp(`^${label} History `),
  });
  await expect(row).toBeVisible();
  const disabled = (await row.getAttribute("aria-disabled")) === "true";
  await guest.keyboard.press("Escape");
  await expect(
    guest.getByRole("dialog", { name: "Commands and shortcuts" }),
  ).toBeHidden();
  return disabled;
}

/** Header button, palette row and the live flags agree that Undo and Redo are `undo` and `redo`. */
async function expectControls(
  guest: Page,
  state: { undo: boolean; redo: boolean },
): Promise<void> {
  const header = {
    undo: guest.locator('button[aria-label="Undo"]'),
    redo: guest.locator('button[aria-label="Redo"]'),
  };
  for (const label of ["undo", "redo"] as const) {
    if (state[label]) await expect(header[label]).toBeEnabled();
    else await expect(header[label]).toBeDisabled();
  }
  expect(await paletteRowDisabled(guest, "Undo")).toBe(!state.undo);
  expect(await paletteRowDisabled(guest, "Redo")).toBe(!state.redo);
}

async function focusPage(guest: Page): Promise<void> {
  await guest.locator(".timeline-scroll").click({ position: { x: 4, y: 4 } });
  await guest.keyboard.press("Escape");
}

test("an Editor's Mod+Z and Mod+Shift+Z move only the Editor's own step", async ({
  browser,
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    await openHostShare(page, projectPath);
    const token = await createReviewShare(page, projectPath, "editor");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    try {
      const guest = await context.newPage();
      const moves: Response[] = [];
      guest.on("response", (response) => {
        if (isHistoryMove(response)) moves.push(response);
      });
      await openGuestShare(guest, token);
      const attention = guest.getByRole("group", { name: /^Needs attention/ });
      await expectControls(guest, { undo: false, redo: false });

      await guestChapter(guest, token, "Mine", 2, 1);
      await expectControls(guest, { undo: true, redo: false });

      await postDocumentCommand(
        page,
        "e2e-host",
        "AddChapter",
        { time: 6, title: "Hosts" },
        projectPath,
      );
      await expect(guest.getByLabel("Chapter Hosts")).toBeVisible();
      await expectControls(guest, { undo: false, redo: false });

      const hostHead = await historyHead(page, projectPath);
      await focusPage(guest);
      await guest.keyboard.press("ControlOrMeta+Z");
      await expectFeedback(guest, UNDO_SENTENCE);
      expect(moves).toHaveLength(0);
      await expect(attention).toHaveCount(0);
      expect(await historyHead(page, projectPath)).toBe(hostHead);
      expect(chapterTitles(projectPath)).toEqual(["Mine", "Hosts"]);

      await guestChapter(guest, token, "Mine two", 4, 2);
      await expectControls(guest, { undo: true, redo: false });

      const undone = guest.waitForResponse(isHistoryMove);
      await focusPage(guest);
      await guest.keyboard.press("ControlOrMeta+Z");
      expect((await undone).status()).toBe(200);
      await expect(guest.getByLabel("Chapter Mine two")).toHaveCount(0);
      await expectControls(guest, { undo: false, redo: true });
      expect(chapterTitles(projectPath)).toEqual(["Mine", "Hosts"]);

      const redone = guest.waitForResponse(isHistoryMove);
      await guest.keyboard.press("ControlOrMeta+Shift+Z");
      expect((await redone).status()).toBe(200);
      await expect(guest.getByLabel("Chapter Mine two")).toBeVisible();
      await expectControls(guest, { undo: true, redo: false });
      expect(chapterTitles(projectPath)).toEqual(["Mine", "Mine two", "Hosts"]);

      await guest.keyboard.press("ControlOrMeta+Shift+Z");
      await expectFeedback(guest, REDO_SENTENCE);
      expect(moves).toHaveLength(2);
      await goToStage(guest, "review");
      await expect(attention).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
