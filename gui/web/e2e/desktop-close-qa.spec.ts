import { type Browser, expect, test } from "@playwright/test";
import {
  createRecordRoom,
  markSharecutE2e,
  openRecordLink,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test("host publishes close risk across recording and pause, then clears after stop", async ({
  browser,
}: {
  browser: Browser;
}) => {
  await withShareableProject(async (projectPath) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    try {
      await host.addInitScript(() => {
        const target = window as unknown as Record<string, unknown>;
        target.isTauri = true;
        target.__SHARECUT_E2E = true;
      });
      await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
      await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
      const room = await createRecordRoom(host, projectPath);
      await host.getByRole("button", { name: "Menu" }).click();
      await host.getByRole("menuitem", { name: "Record room…" }).click();
      const dialog = host.getByRole("dialog", { name: "Record room" });
      await expect(dialog).toBeVisible();

      await markSharecutE2e(guest);
      await openRecordLink(guest, room.guest.token);
      await guest.getByLabel("Display name").fill("Ava");
      await guest.getByLabel("I am wearing headphones").check();
      await guest.getByRole("button", { name: "Allow microphone" }).click();
      await expect(guest.getByLabel("Level")).toBeVisible();
      await guest.getByRole("button", { name: "Skip" }).click();
      await guest.getByRole("button", { name: "Accept" }).click();
      await expect(
        dialog.getByRole("button", { name: "Start", exact: true }),
      ).toBeEnabled();
      await dialog.getByRole("button", { name: "Start", exact: true }).click();
      await expect(
        dialog.getByText("Recording locally on this device."),
      ).toBeVisible();
      await expect
        .poll(() => new URL(host.url()).searchParams.get("sc_close_guard"))
        .toBe("host");

      await dialog.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(dialog.locator(".record-rec-label")).toHaveText("PAUSED");
      expect(new URL(host.url()).searchParams.get("sc_close_guard")).toBe(
        "host",
      );

      await dialog.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(dialog.locator(".record-rec-label")).toHaveText("Stopped");
      await expect
        .poll(() => new URL(host.url()).searchParams.has("sc_close_guard"))
        .toBe(false);
      expect(new URL(host.url()).searchParams.get("project")).toBe(projectPath);
    } finally {
      await guestContext.close();
      await hostContext.close();
    }
  });
});
