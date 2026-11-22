import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { silenceWav, withShareableProject } from "./shareableProject";
import { deliverPage, openProject } from "./stageNav";

test("desktop Deliver shows recovery when a listed file disappears before Reveal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { isTauri: true });
  });
  await withShareableProject(async (projectPath) => {
    const filename = "aligned_dialogue.wav";
    const exportDir = path.join(path.dirname(projectPath), "export");
    const exportPath = path.join(exportDir, filename);
    await mkdir(exportDir, { recursive: true });
    await writeFile(exportPath, silenceWav());
    await openProject(page, projectPath, { stage: "deliver" });

    const reveal = deliverPage(page).getByRole("button", {
      name: `Reveal ${filename}`,
    });
    await expect(reveal).toBeVisible();
    await rm(exportPath);

    const refusal = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/export/files/reveal" &&
        response.request().method() === "POST",
    );
    await reveal.click();

    const response = await refusal;
    expect(response.request().postDataJSON()).toEqual({
      path: projectPath,
      id: filename,
    });
    expect(response.status()).toBe(404);
    expect(response.headers()["x-sharecut-error-code"]).toBe(
      "export_file_gone",
    );
    const errorToast = page.locator(".ui-toast--error");
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toHaveText(
      /That export file is gone\. Export it again to show it in its folder\./,
    );
    await expect(page.locator('.sr-only[role="status"]')).toHaveText(
      "That export file is gone. Export it again to show it in its folder.",
    );
  });
});
