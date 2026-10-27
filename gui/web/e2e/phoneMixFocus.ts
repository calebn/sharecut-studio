import { expect, type Page, type TestInfo } from "@playwright/test";
import { openPhoneMix } from "./phoneMix";
import { withShareableProject } from "./shareableProject";
import { goToStage, openProject } from "./stageNav";

async function openMixAfterKeyboardFocus(page: Page) {
  await goToStage(page, "edit");
  const trigger = page.getByRole("button", { name: "Mix", exact: true });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const mix = page.getByRole("dialog", { name: "Mix", exact: true });
  await expect(mix).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    mix.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  return mix;
}

async function expectDismissedWithMixFocus(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Mix", exact: true }),
  ).toBeFocused();
}

async function attachCloseFocus(page: Page, info: TestInfo) {
  await info.attach("focus-after-close", {
    body: JSON.stringify(
      await page.evaluate(() => ({
        active: document.activeElement?.outerHTML,
      })),
    ),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("focus-after-close.png") });
}

async function inFreshPhoneProject(
  page: Page,
  viewportHeight: number,
  check: () => Promise<void>,
) {
  await page.setViewportSize({ width: 360, height: viewportHeight });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await check();
  });
}

export async function checkPhoneMixFocus(
  page: Page,
  info: TestInfo,
  tabCommand: "Tab" | "Alt+Tab",
) {
  await inFreshPhoneProject(page, 740, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await mix.getByRole("button", { name: "Close", exact: true }).click();
    await attachCloseFocus(page, info);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 740, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await page.keyboard.press("Escape");
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 1100, async () => {
    const mix = await openMixAfterKeyboardFocus(page);
    await page
      .getByRole("button", { name: "Dismiss", exact: true })
      .click({ position: { x: 8, y: 8 } });
    await expect(mix).toHaveCount(0);
    await expectDismissedWithMixFocus(page);
  });

  await inFreshPhoneProject(page, 740, async () => {
    await openPhoneMix(page);
    await expect(page.getByRole("dialog")).toHaveCount(1);

    const reverseTabCommand =
      tabCommand === "Tab" ? "Shift+Tab" : "Alt+Shift+Tab";
    // Close, the two height actions and the sheet's slider, then the tab bar.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press(reverseTabCommand);
    }
    const tabs = page.getByRole("tablist", { name: "Stages" });
    const edit = tabs.getByRole("tab", { name: /^Edit\b/ });
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(edit).toBeFocused();

    await page.keyboard.press("ArrowRight");
    const review = tabs.getByRole("tab", { name: /^Review\b/ });
    await expect(review).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(edit).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toBeVisible();
  });
}
