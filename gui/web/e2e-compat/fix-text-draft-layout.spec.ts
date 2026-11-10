import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { createRelocatedE2eProject } from "../e2e/liveProject";
import { withShareableProject } from "../e2e/shareableProject";
import { openProject, phone } from "../e2e/stageNav";
import { openScript } from "../e2e/transcriptEdit";

function cleanProject(prefix: string) {
  const copy = createRelocatedE2eProject(prefix);
  const data = JSON.parse(fs.readFileSync(copy.projectPath, "utf8"));
  data.editorial.edit_decisions = [];
  fs.writeFileSync(copy.projectPath, JSON.stringify(data));
  return copy;
}

test("a Fix text draft survives tablet-phone-tablet layout changes", async ({
  page,
}) => {
  let correctionCount = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/api/document/command") &&
      request.postDataJSON()?.type === "CorrectTranscriptWord"
    ) {
      correctionCount += 1;
    }
  });

  await withShareableProject(
    async (projectPath) => {
      await page.setViewportSize({ width: 900, height: 900 });
      await openProject(page, projectPath, { stage: "edit" });
      const list = await openScript(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-shell",
        "tablet",
      );
      await list
        .getByRole("button", { name: /^my(?: \(.*\))?$/ })
        .first()
        .focus();
      await page.keyboard.press("F2");
      const field = page.getByRole("textbox", {
        name: "Fix text",
        exact: true,
      });
      await field.fill("layoutproof");

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator("html")).toHaveAttribute("data-shell", "phone");
      expect(correctionCount).toBe(0);
      if (!(await field.isVisible())) {
        await phone.showText(page);
      }
      await expect(field).toHaveValue("layoutproof");

      await page.setViewportSize({ width: 900, height: 900 });
      await expect(page.locator("html")).toHaveAttribute(
        "data-shell",
        "tablet",
      );
      await expect(field).toBeVisible();
      await expect(field).toHaveValue("layoutproof");
      expect(correctionCount).toBe(0);

      const corrected = page.waitForResponse(
        (response) =>
          response.url().includes("/api/document/command") &&
          response.request().postDataJSON()?.type === "CorrectTranscriptWord",
      );
      await field.press("Enter");
      const response = await corrected;
      expect(response.request().postDataJSON().payload).toMatchObject({
        text: "layoutproof",
        expected_text: "my",
      });
      expect((await response.json()).type).toBe("Applied");
      await expect(
        list.getByRole("button", { name: /^layoutproof(?: \(.*\))?$/ }),
      ).toBeVisible();
      expect(correctionCount).toBe(1);

      await page.keyboard.press("ControlOrMeta+z");
      await expect(
        list.getByRole("button", { name: /^my(?: \(.*\))?$/ }).first(),
      ).toBeVisible();
      await expect(
        list.getByRole("button", { name: /^layoutproof(?: \(.*\))?$/ }),
      ).toHaveCount(0);
    },
    undefined,
    cleanProject,
  );
});
