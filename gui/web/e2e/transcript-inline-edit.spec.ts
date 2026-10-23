import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postHistoryMove } from "./documentCommand";
import { e2eProjectPath } from "./env";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test.describe("Transcript inline word edit", () => {
  test("focused word F2 edits and native Enter seeks without opening an editor", async ({
    page,
  }) => {
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
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
    await expect(page.locator(".timecode-current")).toHaveText(
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
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
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
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await page.getByRole("button", { name: "Text", exact: true }).click();
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
    await expectPageAxeClean(page, ".bottom-sheet");

    let committed = false;
    try {
      await field.fill("My");
      await apply.click();
      committed = true;
      await expect(
        list.getByRole("button", { name: "My", exact: true }).first(),
      ).toBeVisible();
      await postHistoryMove(page, "e2e-phone-correct", "UndoHistory");
      committed = false;
      await expect(word).toBeVisible();
    } finally {
      if (committed)
        await postHistoryMove(page, "e2e-phone-correct", "UndoHistory");
    }
  });
});
