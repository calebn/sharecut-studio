import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand, postHistoryMove } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openProject, phone } from "./stageNav";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test.describe("Script Fix text", () => {
  test("F2 on a focused word opens Fix text and Escape gives the word back its focus", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const list = await openTranscriptPanel(page);
    const word = list.getByRole("button", { name: "my", exact: true }).first();
    await word.focus();
    await page.keyboard.press("F2");
    const input = list.getByRole("textbox", { name: "Fix text" });
    await expect(input).toBeFocused();
    await expectPageAxeClean(page, ".sys-script");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(word).toBeFocused();
  });
  test("double-click, type, Enter commits one undoable step; Mod+Z restores", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /aligned dialogue/i,
    );
    const list = await openTranscriptPanel(page);
    const original = list
      .getByRole("button", { name: "my", exact: true })
      .first();
    let committed = false;
    try {
      await withDocumentCommandTypes(page, async (commands) => {
        await original.dblclick();
        const input = list.getByRole("textbox", { name: "Fix text" });
        await expect(input).toBeFocused();
        await input.press("Escape");
        await expect(input).toHaveCount(0);
        expect(commands).not.toContain("CorrectTranscriptWord");

        await original.dblclick();
        await expect(input).toBeFocused();
        await expectPageAxeClean(page, ".sys-script");
        await input.fill("My");
        await input.press("Enter");
        await expect(
          list.getByRole("button", { name: "My", exact: true }).first(),
        ).toBeVisible();
        committed = true;
        expect(commands).toContain("CorrectTranscriptWord");

        await page.keyboard.press("ControlOrMeta+Z");
        await expect(
          list.getByRole("button", { name: "my", exact: true }).first(),
        ).toBeVisible();
        await expect(
          list.getByRole("button", { name: "My", exact: true }),
        ).toHaveCount(0);
        committed = false;
      });
    } finally {
      if (committed) {
        // Leave the shared live E2E project as later specs expect it.
        await postHistoryMove(page, "e2e-inline-edit", "UndoHistory");
      }
    }
  });
});

test.describe("Phone Fix text", () => {
  test.use({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
    reducedMotion: "reduce",
  });

  test("a double tap opens Fix text in the Script and Undo restores the word", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await phone.showText(page);
    const list = page.locator(".sys-script-body");
    const word = list.getByRole("button", { name: "my", exact: true }).first();
    await word.scrollIntoViewIfNeeded();
    const point = await word.boundingBox();
    expect(point).not.toBeNull();
    const x = point!.x + point!.width / 2;
    const y = point!.y + point!.height / 2;
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);

    const field = list.getByRole("textbox", { name: "Fix text" });
    await expect(field).toBeFocused();
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(field).toBeInViewport({ ratio: 1 });
    await expectPageAxeClean(page, ".sys-script");

    let savedHead: string | null = null;
    let failed = false;
    let failure: unknown;
    try {
      await field.fill("My");
      const saving = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/api/document/command") &&
          response.request().postDataJSON()?.type === "CorrectTranscriptWord",
      );
      await field.press("Enter");
      const reply = await saving;
      expect(reply.ok()).toBe(true);
      const result = (await reply.json()) as { history_head_id?: string };
      savedHead = result.history_head_id ?? null;
      expect(savedHead).not.toBeNull();
      await expect(
        list.getByRole("button", { name: "My", exact: true }).first(),
      ).toBeVisible();
      await page
        .locator(".ui-toast-region--app")
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      await expect(word).toBeVisible();
      savedHead = null;
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (savedHead) {
      try {
        await postDocumentCommand(
          page,
          "e2e-phone-correct-cleanup",
          "UndoHistory",
          {
            rerender: false,
            expected_head_id: savedHead,
          },
        );
      } catch (error) {
        if (failed) {
          test.info().annotations.push({
            type: "Correction cleanup failure",
            description: String(error),
          });
        } else {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
  });
});
