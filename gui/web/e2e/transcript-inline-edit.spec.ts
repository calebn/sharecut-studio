import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand, postHistoryMove } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { openProject, phone } from "./stageNav";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test.describe("Transcript inline word edit", () => {
  test("focused word F2 edits and native Enter seeks without opening an editor", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    const list = await openTranscriptPanel(page);
    const word = list.getByRole("button", { name: "my", exact: true }).first();
    await word.focus();
    await page.keyboard.press("F2");
    const input = list.getByRole("textbox", { name: /Correct word/ });
    await expect(input).toBeFocused();
    await expectPageAxeClean(page, ".transcript-panel");
    await input.press("Escape");
    await expect(word).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    await expect(word).toBeFocused();
    await expect(page.locator(".sys-player-now")).toHaveText(
      /^00:02\.(379|380)$/,
    );
    const correct = page.getByRole("button", {
      name: /^(Correct:|Exit Correct)/,
    });
    await correct.focus();
    await page.keyboard.press("Enter");
    await expect(correct).toHaveAttribute("aria-pressed", "true");
    await word.focus();
    await page.keyboard.press("F2");
    await expect(input).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("textbox", { name: "Corrected text", exact: true }),
    ).toBeVisible();
    await correct.click();
    await page.getByRole("button", { name: /^Select:/ }).click();
    await word.focus();
    await page.keyboard.press("F2");
    await expect(input).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(word).toHaveClass(/selected/);
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
        const input = list.getByRole("textbox", { name: /Correct word/ });
        await expect(input).toBeFocused();
        await input.press("Escape");
        await expect(input).toHaveCount(0);
        expect(commands).not.toContain("CorrectTranscriptWord");

        await original.dblclick();
        await expect(input).toBeFocused();
        await expectPageAxeClean(page, ".transcript-panel");
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

test.describe("Phone word correction", () => {
  test.use({
    viewport: { width: 320, height: 568 },
    hasTouch: true,
    reducedMotion: "reduce",
  });

  test("Corrected text and Apply fit in the initial sheet", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await phone.showText(page);
    const list = page.locator(".transcript-list");
    const word = list.getByRole("button", { name: "my", exact: true }).first();
    await word.scrollIntoViewIfNeeded();
    const point = await word.boundingBox();
    expect(point).not.toBeNull();
    const x = point!.x + point!.width / 2;
    const y = point!.y + point!.height / 2;
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);

    const sheet = page.getByRole("dialog", { name: "Inspector", exact: true });
    await expect(sheet).toBeVisible();
    // The sheet opens at half, which leaves this 320 px screen too little for the form.
    await sheet.getByRole("slider", { name: "Sheet height" }).focus();
    await page.keyboard.press("End");
    await expect(sheet).toHaveAttribute("data-detent", "full");
    const field = sheet.getByRole("textbox", {
      name: "Corrected text",
      exact: true,
    });
    const apply = sheet.getByRole("button", { name: "Apply", exact: true });
    const bounds = await sheet.boundingBox();
    expect(bounds).not.toBeNull();
    for (const control of [field, apply]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        bounds!.y + bounds!.height,
      );
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await expectPageAxeClean(page, ".sys-inspector");

    await field.fill("");
    await apply.click();
    await expect(sheet.getByRole("alert")).toHaveText("Text cannot be empty");
    await expect(sheet.getByRole("alert")).toBeInViewport({ ratio: 1 });

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
      await apply.click();
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
