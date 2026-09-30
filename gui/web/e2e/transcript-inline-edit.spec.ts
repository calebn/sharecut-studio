import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
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
    const word = list
      .getByRole("button", { name: "welcome", exact: true })
      .first();
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
    await expect(page.locator(".timecode-current")).toHaveText("00:02.000");
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
      .getByRole("button", { name: "welcome", exact: true })
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
        await input.fill("Welcome");
        await input.press("Enter");
        await expect(
          list.getByRole("button", { name: "Welcome", exact: true }).first(),
        ).toBeVisible();
        committed = true;
        expect(commands).toContain("CorrectTranscriptWord");

        await page.keyboard.press("ControlOrMeta+Z");
        await expect(
          list.getByRole("button", { name: "welcome", exact: true }).first(),
        ).toBeVisible();
        await expect(
          list.getByRole("button", { name: "Welcome", exact: true }),
        ).toHaveCount(0);
        committed = false;
      });
    } finally {
      if (committed) {
        // Leave the shared live E2E project as later specs expect it.
        await page.request.post(
          `/api/document/command?path=${encodeURIComponent(e2eProjectPath)}`,
          {
            data: {
              type: "UndoHistory",
              payload: { rerender: false },
              client_id: "e2e-inline-edit",
              role: "viewer",
            },
          },
        );
      }
    }
  });
});
