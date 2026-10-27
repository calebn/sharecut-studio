import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { switchE2eProject } from "./shareableProject";
import { addTrack, openPanel } from "./stageNav";

test("new project stays fresh without an audio error on desktop and phone", async ({
  page,
}) => {
  assertDisposableE2eProject(e2eProjectPath);
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-fresh-"),
  );
  let registered = false;
  try {
    registered = registerE2eCleanupWorkspace(workspaceDir);
    if (!registered) {
      throw new Error("E2E workspace cleanup registration unavailable");
    }
    await page.addInitScript(() => {
      window.localStorage.setItem("sharecut.bootstrap.skip", "1");
    });
    await page.goto("/?home=1");
    await page.getByRole("button", { name: "New project…" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Fresh QA");
    await page
      .getByRole("textbox", { name: "Workspace directory" })
      .fill(workspaceDir);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    const audioError = page.locator(".sys-player-pill", {
      hasText: "Audio error",
    });
    await expect(page.getByRole("heading", { name: "Fresh QA" })).toBeVisible();
    await expect(audioError).toHaveCount(0);

    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toBeVisible();
    await openPanel(page, "transcript");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    const playbackProbe = await page.evaluateHandle(() => {
      const button = document.querySelector(".sys-play-btn");
      if (!button) throw new Error("Player Play is missing");
      const labels: (string | null)[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          labels.push(record.oldValue, button.getAttribute("aria-label"));
        }
      });
      observer.observe(button, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["aria-label"],
      });
      return { observer, labels };
    });
    try {
      await page.keyboard.press("Space");
      await expect(play).toHaveAccessibleName("Play");
      const labels = await playbackProbe.evaluate((probe) => {
        for (const record of probe.observer.takeRecords()) {
          probe.labels.push(record.oldValue);
        }
        return probe.labels;
      });
      expect(labels).not.toContain("Pause");
    } finally {
      await playbackProbe.evaluate((probe) => probe.observer.disconnect());
      await playbackProbe.dispose();
    }

    await addTrack(page);
    await expect(audioError).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".stage-frame-player")).toBeVisible();
    await expect(page.getByText("Mix out of date")).toHaveCount(0);
    await expect(audioError).toHaveCount(0);
  } finally {
    try {
      await page.close();
    } finally {
      try {
        await switchE2eProject(e2eProjectPath);
      } finally {
        if (!registered) {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
      }
    }
  }
});
