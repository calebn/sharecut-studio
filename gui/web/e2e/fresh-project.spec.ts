import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";

test("new project stays fresh without an audio error on desktop and phone", async ({
  page,
}) => {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "sharecut-e2e-fresh-"),
  );
  expect(registerE2eCleanupWorkspace(workspaceDir)).toBe(true);
  try {
    await page.addInitScript(() => {
      window.localStorage.setItem("sharecut.bootstrap.skip", "1");
    });
    await page.goto("/");
    await page.getByRole("button", { name: "New project…" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Fresh QA");
    await page
      .getByRole("textbox", { name: "Workspace directory" })
      .fill(workspaceDir);
    await page.getByRole("button", { name: "Create", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Fresh QA" })).toBeVisible();
    await expect(page.getByText("Fresh", { exact: true })).toBeVisible();
    await expect(page.getByText("Err", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "+ Track" }).click();
    await expect(page.getByText("Fresh", { exact: true })).toBeVisible();
    await expect(page.getByText("Err", { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".mobile-listen-transport")).toBeVisible();
    await expect(page.getByText("Stale render")).toHaveCount(0);
    await expect(page.getByText("Err", { exact: true })).toHaveCount(0);
  } finally {
    await page.close();
  }
});
