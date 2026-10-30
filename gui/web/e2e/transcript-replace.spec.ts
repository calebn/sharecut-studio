import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import {
  openTranscriptPanel,
  SCRIPT_WORD,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test("replace all is one command and one Undo restores every instance", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const list = await openTranscriptPanel(page);
  const words = (text: RegExp) =>
    list.locator(SCRIPT_WORD).filter({ hasText: text });
  await expect(words(/^delighted$/i).first()).toBeVisible();
  const originalCount = await words(/^delighted$/i).count();
  expect(originalCount).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Find in transcript" }).click();
  const bar = page.getByRole("search", { name: "Find in transcript" });
  await bar
    .getByRole("searchbox", { name: "Find", exact: true })
    .fill("delighted");
  await bar.getByRole("button", { name: "Show replace" }).click();
  await bar
    .getByRole("textbox", { name: "Replace with" })
    .fill("Testreplacement");
  await expectPageAxeClean(page, ".sys-script");
  await withDocumentCommandTypes(page, async (types) => {
    await bar.getByRole("button", { name: "Replace all" }).click();
    await expect(words(/^delighted$/i)).toHaveCount(0);
    await expect(words(/^Testreplacement$/)).toHaveCount(originalCount);
    expect(
      types.filter((type) => type === "ReplaceTranscriptMatches"),
    ).toHaveLength(1);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(words(/^delighted$/i)).toHaveCount(originalCount);
    await expect(words(/^Testreplacement$/)).toHaveCount(0);
    expect(types.filter((type) => type === "UndoHistory")).toHaveLength(1);
  });
});
