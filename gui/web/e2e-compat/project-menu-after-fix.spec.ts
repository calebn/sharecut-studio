import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject, projectMenuButton } from "../e2e/stageNav";
import { openScript } from "../e2e/transcriptEdit";

test("Project menu keeps focus after a blurred Fix text save and Undo restores the word", async ({
  page,
}) => {
  const corrections: unknown[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/api/document/command") &&
      request.postDataJSON()?.type === "CorrectTranscriptWord"
    ) {
      corrections.push(request.postDataJSON());
    }
  });

  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 900, height: 900 });
      await openProject(page, projectPath, { stage: "edit" });
      const script = await openScript(page);
      await script
        .getByRole("button", { name: /^my(?: \(.*\))?$/ })
        .first()
        .focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", {
        name: "Fix text",
        exact: true,
      });
      await field.fill("blurproof");
      await expect(field).toBeFocused();
      const corrected = page.waitForResponse(
        (response) =>
          response.url().includes("/api/document/command") &&
          response.request().postDataJSON()?.type === "CorrectTranscriptWord",
      );
      await projectMenuButton(page).click();
      const response = await corrected;
      expect(response.request().postDataJSON()).toMatchObject({
        type: "CorrectTranscriptWord",
        payload: {
          track_id: "reference",
          word_index: 0,
          text: "blurproof",
          expected_text: "my",
        },
      });
      expect((await response.json()).type).toBe("Applied");
      await expect(
        script.getByRole("button", { name: /^blurproof(?: \(.*\))?$/ }),
      ).toBeVisible();

      const menu = page.getByRole("menu", { name: "Project menu" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      expect(corrections).toHaveLength(1);

      await page.keyboard.press("Escape");
      await page.keyboard.press("ControlOrMeta+z");
      await expect(
        script.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first(),
      ).toBeVisible();
      await expect(
        script.getByRole("button", { name: /^blurproof(?: \(.*\))?$/ }),
      ).toHaveCount(0);
      expect(corrections).toHaveLength(1);
    },
    undefined,
    (prefix) => {
      const copy = createRelocatedE2eProject(prefix);
      const project = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
      project.editorial.edit_decisions = [];
      fs.writeFileSync(copy.projectPath, JSON.stringify(project));
      return copy;
    },
  );
});
