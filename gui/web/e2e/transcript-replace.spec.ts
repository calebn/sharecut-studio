import { expect, test } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { postDocumentCommand } from "./documentCommand";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import {
  openScript,
  SCRIPT_WORD,
  withDocumentCommandTypes,
} from "./transcriptEdit";

test("replace all is one command and one Undo restores every instance", async ({
  page,
}) => {
  await openProject(page, e2eProjectPath);
  const list = await openScript(page);
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

test("a remote cut clears the deleted current Find match", async ({ page }) => {
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    const body = await openScript(page);
    const peer = await page.context().newPage();
    try {
      await openProject(peer, projectPath);
      await page.getByRole("button", { name: "Find in transcript" }).click();
      const bar = page.getByRole("search", { name: "Find in transcript" });
      await bar
        .getByRole("searchbox", { name: "Find", exact: true })
        .fill("delighted");
      await expect(bar).toContainText("1 of 2");
      const current = body.locator('[data-found="current"]');
      await expect(current).toHaveText(/^delighted$/i);

      await peer.request.post("/api/transcript/refine/waive", {
        data: { path: projectPath, reason: "e2e Script Find" },
      });
      await postDocumentCommand(
        peer,
        "e2e-script-find-remote-cut",
        "CutRange",
        { mode: "ripple", start: 2.9, end: 3.65 },
        projectPath,
      );
      await expect(bar).toContainText("1 match");
      await expect(current).toHaveCount(0);
      await bar.getByRole("button", { name: "Next match" }).click();
      await expect(bar).toContainText("1 of 1");
      await expect(current).toHaveText(/^delighted$/i);
      await bar.getByRole("button", { name: "Show replace" }).click();
      await bar.getByRole("textbox", { name: "Replace with" }).fill("Glad");
      await bar.getByRole("button", { name: "Replace", exact: true }).click();
      await expect(
        body.locator(SCRIPT_WORD).filter({ hasText: /^Glad$/ }),
      ).toHaveCount(1);
    } finally {
      await peer.close();
    }
  });
});
