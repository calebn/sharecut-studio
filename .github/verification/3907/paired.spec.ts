import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as baseTest, expect } from "@playwright/test";
import { expectPageAxeClean } from "./axe";
import { registerE2eCleanupWorkspace } from "./cleanupManifest";
import { assertDisposableE2eProject, e2eProjectPath } from "./env";
import { createEpisodeFromHome, openHome } from "./home";
import { silenceWav, switchE2eProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";
import { withTwoBrowserPages } from "./twoBrowserPages";

const test = baseTest;
test.use({ trace: "off", screenshot: "off", video: "off" });

const side = process.env.RETRY_PARITY_SIDE;
if (side !== "control" && side !== "candidate")
  throw new Error("Retry parity side is required");

const profiles = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "tablet", viewport: { width: 820, height: 1100 }, touch: true },
  { name: "phone", viewport: { width: 390, height: 844 }, touch: true },
];

test("Host Script keeps status and hides Retry only when fixed", async ({
  page,
}) => {
  await page.routeWebSocket(/\/api\/host\/ws/, () => undefined);
  await page.route(
    (url) => new URL(url).pathname === "/api/document/state",
    () => {},
  );
  await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`, {
    waitUntil: "commit",
  });

  const script = page.getByRole("region", { name: "Script", exact: true });
  await expect(script.getByRole("status")).toContainText("Still loading…");
  const retry = script.getByRole("button", { name: "Retry", exact: true });
  if (side === "control") {
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toBeVisible();
    await expect(script.getByRole("status")).toContainText("Still loading…");
  } else {
    await expect(retry).toHaveCount(0);
  }
  await expectPageAxeClean(page);
});

for (const profile of profiles) {
  test(`Editor Retry recovers on ${profile.name}`, async ({ browser }) => {
    assertDisposableE2eProject(e2eProjectPath);
    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sharecut-e2e-guest-retry-"),
    );
    let registered = false;
    try {
      registered = registerE2eCleanupWorkspace(workspaceDir);
      if (!registered) throw new Error("E2E cleanup registration is required");
      await withTwoBrowserPages(
        browser,
        {},
        { viewport: profile.viewport, hasTouch: profile.touch },
        async (host, guest) => {
          await openHome(host);
          await createEpisodeFromHome(host, {
            name: "Guest Retry QA",
            workspaceDir,
          });
          const projectPath = new URL(host.url()).searchParams.get("project");
          if (!projectPath) throw new Error("Created project path is required");
          assertDisposableE2eProject(projectPath);
          await expect(
            host.getByRole("dialog", { name: "Invite" }),
          ).toBeVisible();
          await host.keyboard.press("Escape");
          const artifacts = path.join(workspaceDir, "artifacts");
          fs.mkdirSync(artifacts, { recursive: true });
          fs.writeFileSync(path.join(artifacts, "premix.wav"), silenceWav());
          const token = await createReviewShare(host, projectPath, "editor");
          const shellPath = `/api/review/${token}/daw/document/state`;
          let held = true;
          let shellRequests = 0;
          await guest.route(`**${shellPath}*`, (route) => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("phase") !== "shell")
              return route.continue();
            shellRequests += 1;
            if (held) return;
            return route.continue();
          });
          await guest.routeWebSocket(
            (url) => url.pathname === `/api/review/${token}/daw/ws`,
            () => {},
          );
          await guest.goto(`/r/${token}`, { waitUntil: "domcontentloaded" });
          await expect.poll(() => shellRequests).toBe(1);
          const editor = guest.locator(".stage-host");
          await expect(editor).toHaveAttribute("aria-busy", "true");
          const retry = editor.getByRole("button", {
            name: "Retry",
            exact: true,
          });
          await expect(retry).toBeVisible();
          await expect(
            editor.getByRole("status").filter({ hasText: "Still loading…" }),
          ).toBeInViewport();
          await expect(retry).toBeInViewport();
          if (profile.touch) {
            const dimensions = await retry.boundingBox();
            expect(dimensions?.width ?? 0).toBeGreaterThanOrEqual(44);
            expect(dimensions?.height ?? 0).toBeGreaterThanOrEqual(44);
          }
          const answer = guest.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === shellPath &&
              url.searchParams.get("phase") === "shell"
            );
          });
          if (profile.name === "desktop") {
            await retry.focus();
            await expect(retry).toBeFocused();
          }
          held = false;
          if (profile.name === "desktop") await guest.keyboard.press("Enter");
          else await retry.tap();
          const response = await answer;
          expect(response.status()).toBe(200);
          expect(await response.json()).toMatchObject({
            project: { meta: { name: "Guest Retry QA" } },
          });
          await expect.poll(() => shellRequests).toBe(2);
          await expect(
            guest.locator('.stage-host[aria-busy="true"]'),
          ).toHaveCount(0);
          await expect(guest.locator(".stage-frame--guest")).toBeVisible();
          await expect(retry).toHaveCount(0);
          expect(new URL(guest.url()).pathname).toBe(`/r/${token}`);
        },
      );
    } finally {
      try {
        await switchE2eProject(e2eProjectPath);
      } finally {
        if (!registered)
          fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    }
  });
}
