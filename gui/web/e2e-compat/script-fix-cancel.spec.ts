import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { openProject } from "../e2e/stageNav";
import { openScript, withDocumentCommandTypes } from "../e2e/transcriptEdit";

test("Fix text Cancel discards the draft even where blur precedes the click", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const script = await openScript(page);
  const word = script.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first();
  await word.focus();
  await page.keyboard.press("F2");
  const field = script.getByRole("textbox", { name: "Fix text" });
  await expect(field).toBeFocused();
  await withDocumentCommandTypes(page, async (commands) => {
    await field.fill("not saved");
    await script.getByRole("button", { name: "Cancel fix" }).click();
    await expect(field).toHaveCount(0);
    await expect(word).toBeFocused();
    expect(commands).toEqual([]);
  });
});
