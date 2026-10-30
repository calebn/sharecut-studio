import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import { expectFeedback } from "./feedback";
import { openProject } from "./stageNav";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test("rename a transcript speaker updates all its turns and Undo restores them", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const list = await openTranscriptPanel(page);
  const original = list
    .getByRole("button", { name: /, change speaker$/ })
    .first();
  const oldLabel = (await original.innerText()).trim();
  const named = (name: string) =>
    list.getByRole("button", { name: `${name}, change speaker`, exact: true });
  const count = await named(oldLabel).count();
  expect(count).toBeGreaterThan(1);
  await withDocumentCommandTypes(page, async (commands) => {
    await original.click();
    await page
      .getByRole("button", { name: /Fix text/ })
      .first()
      .click();
    const input = page.getByRole("textbox", { name: `Name for ${oldLabel}` });
    await expect(input).toBeFocused();
    await expectPageAxeClean(page, ".sys-popover, .sys-sheet, .sys-script");
    await input.fill("Renamed speaker");
    await input.press("Enter");
    await expect(named("Renamed speaker")).toHaveCount(count);
    expect(commands.filter((type) => type === "SetTrackMeta")).toHaveLength(1);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(named(oldLabel)).toHaveCount(count);
    await expect(named("Renamed speaker")).toHaveCount(0);
  });
});

test("queued speaker save stays visible and reports pending delivery", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const list = await openTranscriptPanel(page);
  await page.route("**/api/document/command?**", async (route) => {
    if (route.request().postDataJSON()?.type === "SetTrackMeta")
      await route.abort("failed");
    else await route.continue();
  });
  const first = list.getByRole("button", { name: /, change speaker$/ }).first();
  const oldLabel = (await first.innerText()).trim();
  await first.click();
  await page
    .getByRole("button", { name: /Fix text/ })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: `Name for ${oldLabel}` });
  await input.fill("Queued speaker");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(
    list
      .getByRole("button", {
        name: "Queued speaker, change speaker",
        exact: true,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: /^Needs attention\. 1 pending(?:,|$)/,
    }),
  ).toBeVisible();
  await expectFeedback(page, "Track metadata change queued. Still sending.", {
    superseded: true,
  });
});
