import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { openProject } from "./stageNav";
import { openScript } from "./transcriptEdit";

test("every Script word carries the presence anchor another person's cursor lands on", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const body = await openScript(page);
  const words = body.locator(".sys-script-word");
  const total = await words.count();
  expect(total).toBeGreaterThan(1);
  await expect(
    body.locator(".sys-script-word[data-presence-anchor^='transcript:word:']"),
  ).toHaveCount(total);
});
