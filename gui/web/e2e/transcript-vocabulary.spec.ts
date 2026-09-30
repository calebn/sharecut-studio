import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";

test("shows the real prompt budget before saving and persists a fitting draft", async ({
  page,
}, testInfo) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  await page
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Pipeline", exact: true })
    .click();
  const editor = page.getByRole("region", { name: "Transcription vocabulary" });
  const input = editor.getByLabel("Terms", { exact: true });
  await expect(input).toBeEnabled();
  const names = ["A", "B", "C", "D"].map((letter) => letter.repeat(100));
  for (const name of names) {
    await input.fill(name);
    await editor.getByRole("button", { name: "Add term", exact: true }).click();
  }
  const save = editor.getByRole("button", { name: "Save vocabulary" });
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
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/transcript/vocabulary") &&
      response.request().method() === "PUT",
  );
  await save.click();
  expect((await saved).status()).toBe(200);
  await expect(
    editor.getByText("Vocabulary saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByLabel("Editor panels")
    .getByRole("button", { name: "Pipeline", exact: true })
    .click();
  for (const name of names.slice(0, 3)) {
    await expect(
      editor.getByRole("button", { name: `Remove ${name}` }),
    ).toBeVisible();
  }
});
