import { expect, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openPanel, openProject } from "./stageNav";

function savedVocabulary(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().includes("/api/transcript/vocabulary") &&
      response.request().method() === "PUT",
  );
}

test("saves each term as it is added, refuses one past the prompt budget, and keeps them after a reload", async ({
  page,
}, testInfo) => {
  await openProject(page, e2eProjectPath);
  await openPanel(page, "pipeline");
  const input = page.getByLabel("Names and terms", { exact: true });
  await expect(input).toBeEnabled();
  const removers = page.getByRole("button", { name: /^Remove / });
  while (await removers.count()) {
    const saved = savedVocabulary(page);
    await removers.first().click();
    expect((await saved).status()).toBe(200);
  }
  const names = ["A", "B", "C", "D"].map((letter) => letter.repeat(100));
  const added: string[] = [];
  for (const name of names) {
    await input.fill(name);
    const saved = savedVocabulary(page);
    await input.press("Enter");
    if (
      await page
        .getByText("That is the limit. Remove a term to add more.")
        .isVisible()
    ) {
      break;
    }
    expect((await saved).status()).toBe(200);
    added.push(name);
  }
  expect(added.length).toBeGreaterThan(0);
  expect(added.length).toBeLessThan(names.length);
  await expect(
    page.getByText("That is the limit. Remove a term to add more."),
  ).toBeVisible();
  await expectPageAxeClean(page, ".sys-vocab");
  await page.screenshot({
    path: testInfo.outputPath("vocabulary-prompt-limit.png"),
  });
  await page.reload();
  await openPanel(page, "pipeline");
  for (const name of added) {
    await expect(
      page.getByRole("button", { name: `Remove ${name}` }),
    ).toBeVisible();
  }
});
