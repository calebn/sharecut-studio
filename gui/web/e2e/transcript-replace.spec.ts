import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test("reviewed replace all is one command and one Undo restores every instance", async ({
  page,
}) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const list = await openTranscriptPanel(page);
  const word = list
    .locator(".utterance-word")
    .filter({ hasText: /^documented$/i })
    .first();
  await expect(word).toBeVisible();
  const originalCount = await list
    .locator(".utterance-word")
    .filter({ hasText: /^documented$/i })
    .count();
  expect(originalCount).toBeGreaterThan(1);
  await page
    .getByRole("button", { name: "Find and replace", exact: true })
    .click();
  const replace = page.getByRole("region", {
    name: "Find and replace transcript",
  });
  await replace
    .getByRole("textbox", { name: "Find", exact: true })
    .fill("documented");
  await replace
    .getByRole("textbox", { name: "Replace with" })
    .fill("Testreplacement");
  await replace.getByRole("button", { name: "Preview replacements" }).click();
  await expect(
    replace.getByRole("list", { name: "Replacement preview" }),
  ).toBeVisible();
  await expectPageAxeClean(page, ".transcript-panel");
  await withDocumentCommandTypes(page, async (types) => {
    await replace.getByRole("button", { name: /^Replace all/ }).click();
    await expect(
      replace.getByRole("button", { name: "Undo replacements" }),
    ).toBeEnabled();
    await expect(
      list.locator(".utterance-word").filter({ hasText: /^documented$/i }),
    ).toHaveCount(0);
    await expect(
      list.locator(".utterance-word").filter({ hasText: /^Testreplacement$/ }),
    ).toHaveCount(originalCount);
    expect(
      types.filter((type) => type === "ReplaceTranscriptMatches"),
    ).toHaveLength(1);
    await replace.getByRole("button", { name: "Undo replacements" }).click();
    await expect(
      list.locator(".utterance-word").filter({ hasText: /^documented$/i }),
    ).toHaveCount(originalCount);
    await expect(
      list.locator(".utterance-word").filter({ hasText: /^Testreplacement$/ }),
    ).toHaveCount(0);
    expect(types.filter((type) => type === "UndoHistory")).toHaveLength(1);
  });
});
