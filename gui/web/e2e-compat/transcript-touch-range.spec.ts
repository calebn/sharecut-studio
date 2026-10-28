import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject, phone } from "../e2e/stageNav";

/*
 * #1029: Select mode works by touch on Chromium and WebKit. A long press on a
 * word arms a range and a drag over more words selects them; the selection
 * sheet opens when the finger lifts and never covers the selected words; the
 * Words controls add and drop a word without any gesture.
 */

test.use({ hasTouch: true, isMobile: true });

const WORDS = "[data-transcript-word][data-track-id]";

async function touch(
  page: Page,
  type: "pointerdown" | "pointermove" | "pointerup",
  index: number,
) {
  await page.evaluate(
    ({ type, index, selector }) => {
      const chips = [...document.querySelectorAll<HTMLElement>(selector)];
      const chip = chips[index]!;
      const r = chip.getBoundingClientRect();
      chip.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerType: "touch",
          pointerId: 7,
          isPrimary: true,
          button: 0,
          clientX: r.x + r.width / 2,
          clientY: r.y + r.height / 2,
        }),
      );
    },
    { type, index, selector: WORDS },
  );
}

test("a long press then a drag selects a word range, and the dock clears it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await phone.showText(page);
    await page.getByRole("button", { name: /^Select/ }).click();
    await expect(page.locator(WORDS).nth(3)).toBeVisible();

    await touch(page, "pointerdown", 0);
    await page.waitForTimeout(650);
    await touch(page, "pointermove", 1);
    await touch(page, "pointermove", 3);
    await expect(page.locator(".utterance-word.selected")).toHaveCount(4);
    await expect(
      page.getByRole("group", { name: "Words in range" }),
    ).toHaveCount(0);
    await touch(page, "pointerup", 3);

    const words = page.getByRole("group", { name: "Words in range" });
    await expect(words).toContainText("4 words");
    await expect(page.locator(".utterance-word.selected")).toHaveCount(4);

    const clear = await page.evaluate(() => {
      const sheet = document.querySelector(".edit-dock");
      const last = [
        ...document.querySelectorAll(".utterance-word.selected"),
      ].at(-1);
      if (!sheet || !last) return null;
      return (
        last.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().top
      );
    });
    expect(clear).toBe(true);

    await words.getByRole("button", { name: "Add word after" }).click();
    await expect(words).toContainText("5 words");
    await words.getByRole("button", { name: "Drop first word" }).click();
    await expect(words).toContainText("4 words");
  });
});

test("a finger that moves before the hold scrolls and selects nothing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await phone.showText(page);
    await page.getByRole("button", { name: /^Select/ }).click();
    await expect(page.locator(WORDS).nth(3)).toBeVisible();

    await touch(page, "pointerdown", 0);
    await touch(page, "pointermove", 3);
    await page.waitForTimeout(650);
    await touch(page, "pointermove", 3);
    await touch(page, "pointerup", 3);
    await expect(page.locator(".utterance-word.selected")).toHaveCount(0);
  });
});
