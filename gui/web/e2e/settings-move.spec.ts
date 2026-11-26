import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { openProjectMenuItem } from "./stageNav";

async function openMoveSettings(page: Page, projectPath: string) {
  await openHostShare(page, projectPath);
  await page.evaluate(() => {
    (window as Window & { isTauri?: boolean }).isTauri = true;
  });
  await openProjectMenuItem(page, "Settings…");
  return page.getByRole("dialog", { name: "Settings" });
}

test("Settings explains a bad folder picker response before attempting a move", async ({
  page,
}) => {
  await withShareableProject(async (projectPath) => {
    let moves = 0;
    await page.route("**/api/project/move", (route) => {
      moves++;
      return route.abort();
    });
    await page.route("**/api/project/pick-folder", (route) =>
      route.fulfill({ json: { malformed: true } }),
    );
    const sheet = await openMoveSettings(page, projectPath);
    await sheet.getByRole("button", { name: "Move…" }).click();
    await expect(
      sheet.getByText(
        "Couldn't open the selected folder. The move hasn't started. Try Move again.",
      ),
    ).toBeVisible();
    expect(moves).toBe(0);
    expect(fs.existsSync(projectPath)).toBe(true);
  });
});

test("Settings asks the host to check the destination after a move response is lost", async ({
  page,
}) => {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-move-"),
  );
  try {
    await withShareableProject(async (projectPath) => {
      await page.route("**/api/project/pick-folder", (route) =>
        route.fulfill({ json: { folder: destination } }),
      );
      let releaseResponse!: () => void;
      const holdResponse = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      await page.route("**/api/project/move", async (route) => {
        const response = await route.fetch({ maxRetries: 0 });
        expect(response.ok(), await response.text()).toBe(true);
        await holdResponse;
        await route.abort("connectionreset");
      });
      const sheet = await openMoveSettings(page, projectPath);
      const move = sheet.getByRole("button", { name: /mov(e|ing)…/i });
      const reveal = sheet.getByRole("button", { name: "Reveal in folder" });
      try {
        await move.click();
        await expect(move).toHaveAccessibleName("Moving…");
        await expect(move).toHaveAttribute("aria-busy", "true");
        await expect(reveal).toBeDisabled();
        await expect(reveal).not.toHaveAttribute("aria-busy");
      } finally {
        releaseResponse();
      }
      await expect(
        sheet.getByText(
          "Couldn't confirm where this episode is. Check the folder you chose and the original folder before trying again.",
        ),
      ).toBeVisible();
      await expect(move).toBeEnabled();
      await expect(reveal).toBeEnabled();
      await expect(move).not.toHaveAttribute("aria-busy");
      expect(fs.existsSync(projectPath)).toBe(false);
      const moved = path.join(
        destination,
        path.basename(path.dirname(projectPath)),
        path.basename(projectPath),
      );
      expect(fs.existsSync(moved)).toBe(true);
    });
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
});
