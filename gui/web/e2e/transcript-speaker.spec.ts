import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { e2eProjectPath } from "./env";
import {
  openTranscriptPanel,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test("rename and reassign a transcript speaker updates all track turns and Undo restores them", async ({
  page,
}) => {
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
  const list = await openTranscriptPanel(page);
  const original = list
    .getByRole("button", { name: /^Change speaker/ })
    .first();
  const oldLabel = (await original.innerText()).trim();
  const count = await list
    .getByRole("button", { name: `Change speaker ${oldLabel}`, exact: true })
    .count();
  expect(count).toBeGreaterThan(1);
  await withDocumentCommandTypes(page, async (commands) => {
    await original.click();
    const input = list.getByRole("combobox", { name: "Speaker name" });
    await expect(input).toBeFocused();
    await expectPageAxeClean(page, ".transcript-panel");
    await input.fill("Renamed speaker");
    await input.press("Enter");
    await expect(
      list.getByRole("button", {
        name: "Change speaker Renamed speaker",
        exact: true,
      }),
    ).toHaveCount(count);
    expect(commands.filter((type) => type === "SetTrackMeta")).toHaveLength(1);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(
      list.getByRole("button", {
        name: `Change speaker ${oldLabel}`,
        exact: true,
      }),
    ).toHaveCount(count);
    await expect(
      list.getByRole("button", {
        name: "Change speaker Renamed speaker",
        exact: true,
      }),
    ).toHaveCount(0);
    const otherSpeaker = list
      .getByRole("button", { name: /^Change speaker/ })
      .filter({ hasNotText: oldLabel })
      .first();
    const reassignedName = (await otherSpeaker.innerText()).trim();
    const otherCount = await list
      .getByRole("button", {
        name: `Change speaker ${reassignedName}`,
        exact: true,
      })
      .count();
    await list
      .getByRole("button", { name: `Change speaker ${oldLabel}`, exact: true })
      .first()
      .click();
    const reassignment = list.getByRole("combobox", { name: "Speaker name" });
    await expect(
      list.locator(`datalist option[value="${reassignedName}"]`),
    ).toHaveCount(1);
    await reassignment.fill(reassignedName);
    await reassignment.press("Enter");
    await expect(
      list.getByRole("button", {
        name: `Change speaker ${reassignedName}`,
        exact: true,
      }),
    ).toHaveCount(count + otherCount);
    await page.keyboard.press("ControlOrMeta+Z");
    await expect(
      list.getByRole("button", {
        name: `Change speaker ${oldLabel}`,
        exact: true,
      }),
    ).toHaveCount(count);
  });
});
