import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { switchE2eProject } from "./shareableProject";

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

    // "Mix up to date" also appears in the status bar once a project loads;
    // scope to the transport's end zone (the desktop Pill) to stay strict.
    const transportEnd = page.locator(".transport-zone--end");
    await expect(page.getByRole("heading", { name: "Fresh QA" })).toBeVisible();
    await expect(
      transportEnd.getByText("Mix up to date", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".pill.audio-error")).toHaveCount(0);

    const play = page.getByRole("button", { name: "Play", exact: true });
    await expect(play).toHaveAccessibleDescription("Import audio to play.");
    await page.getByRole("button", { name: "Transcript", exact: true }).click();
    await page.getByRole("heading", { name: "Fresh QA" }).click();
    const playbackProbe = await page.evaluateHandle(() => {
      const button = document.querySelector(".play-btn");
      if (!button) throw new Error("Transport Play is missing");
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
      await expect(play).toHaveAttribute("data-playing", "false");
      await expect(play).toHaveAccessibleDescription("Import audio to play.");
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

    await page.getByRole("button", { name: "+ Track" }).click();
    await expect(
      transportEnd.getByText("Mix up to date", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".pill.audio-error")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".listen-hero")).toBeVisible();
    await expect(page.getByText("Mix out of date")).toHaveCount(0);
    await expect(page.locator(".pill.audio-error")).toHaveCount(0);
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
