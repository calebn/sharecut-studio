import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openPanel, openProject } from "./stageNav";

async function saveVocabulary(page: Page, save: Locator): Promise<void> {
  const response = page.waitForResponse(
    (response) =>
      response.url().includes("/api/transcript/vocabulary") &&
      response.request().method() === "PUT",
  );
  await save.click();
  expect((await response).status()).toBe(200);
}

test("shows the real prompt budget before saving and persists a fitting draft", async ({
  page,
}, testInfo) => {
  await openProject(page, e2eProjectPath);
  await openPanel(page, "pipeline");
  const editor = page.getByRole("region", { name: "Transcription vocabulary" });
  const input = editor.getByLabel("Terms", { exact: true });
  await expect(input).toBeEnabled();
  const save = editor.getByRole("button", { name: "Save vocabulary" });
  const remove = editor.getByRole("button", { name: /^Remove / });
  if (await remove.count()) {
    while (await remove.count()) await remove.first().click();
    await saveVocabulary(page, save);
    await expect(
      editor.getByText("Vocabulary saved.", { exact: true }),
    ).toBeVisible();
  }
  const names = ["A", "B", "C", "D"].map((letter) => letter.repeat(100));
  for (const name of names) {
    await input.fill(name);
    await editor.getByRole("button", { name: "Add term", exact: true }).click();
  }
  await expect(save).toBeDisabled();
  await expect(save).toHaveAccessibleDescription(
    /Remove terms or guest names before saving vocabulary/,
  );
  await expectPageAxeClean(page, ".pipeline-vocabulary");
  await page.screenshot({
    path: testInfo.outputPath("vocabulary-prompt-overflow.png"),
  });
  await editor.getByRole("button", { name: `Remove ${names[3]}` }).click();
  await expect(save).toBeEnabled();
  await saveVocabulary(page, save);
  await expect(
    editor.getByText("Vocabulary saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openPanel(page, "pipeline");
  for (const name of names.slice(0, 3)) {
    await expect(
      editor.getByRole("button", { name: `Remove ${name}` }),
    ).toBeVisible();
  }
});
