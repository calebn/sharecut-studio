import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  keeperSegmentWavBytes,
  ONE_SECOND_KEEPER_WAV_BYTES,
} from "./keeperOpfs";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  boxOf,
  LAPTOP,
  LIVE_PILL,
  type LiveTake,
  PHONE,
  withLiveTake,
} from "./recordLiveTake";
import {
  ensureHostRecordCommand,
  expectRoomAlert,
  hostRecordConnected,
  hostRecordSnapshot,
  roomPill,
  roomTile,
  waitForSegmentsAcked,
} from "./recordRoom";

const HOST_DROPPED = /dropped\. You're still recording on this device\./;
const HELD_TITLE = "You can leave after this take.";
const WARNING =
  "Leaving stops recording on this device. Keep this page open so it can reach the host.";
const WARNING_SHORT =
  "Leaving stops recording here. Keep this page open to send it.";
const WAIT_MS = 60_000;

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

const leaveOf = (page: Page) =>
  page.getByRole("button", { name: "Leave room" });

async function cutHost({ host, hostNet, projectPath, guest }: LiveTake) {
  await hostNet.drop();
  await expect
    .poll(() => hostRecordConnected(host, projectPath), { timeout: 5_000 })
    .toBe(false);
  const droppedAt = Date.now();
  await expectRoomAlert(guest, HOST_DROPPED);
  return droppedAt;
}

async function guestIsGone(take: LiveTake) {
  await expect
    .poll(
      async () =>
        (
          await hostRecordSnapshot(take.host, take.projectPath)
        ).participants.find((person) => person.participant_id === take.guestId)
          ?.connected,
    )
    .toBe(false);
}

test.describe("guest leaves a take once the host is gone", () => {
  test("laptop: Leave opens after a real minute with the warning, one press leaves, the host sees it", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    await withLiveTake(browser, LAPTOP, async (take) => {
      const { guest, host, roomDlg, hostNet, projectPath, guestKeeper } = take;
      const leave = leaveOf(guest);
      const dock = guest.locator(".sys-dock");
      const heldDock = await boxOf(dock);

      const droppedAt = await cutHost(take);
      await expect(leave).toHaveAttribute("aria-disabled", "true");
      await expect(leave).toHaveAttribute("title", HELD_TITLE);

      await expect(leave).not.toHaveAttribute("aria-disabled", "true", {
        timeout: 75_000,
      });
      const waited = Date.now() - droppedAt;
      expect(waited).toBeGreaterThanOrEqual(WAIT_MS - 1_000);
      expect(waited).toBeLessThan(WAIT_MS + 15_000);
      await expect(leave).toHaveAttribute("title", WARNING);
      await expect(leave).toHaveAccessibleDescription(WARNING);
      const note = guest.locator(".sys-dock-hint");
      await expect(note).toBeVisible();
      await expect(note).toHaveText(WARNING);
      const openDock = await boxOf(dock);
      const noteBox = await boxOf(note);
      expect(noteBox.height).toBeLessThanOrEqual(20);
      expect(openDock.height - heldDock.height).toBeLessThanOrEqual(
        noteBox.height + 12,
      );

      await expect(roomPill(guest)).toHaveText(LIVE_PILL);
      const upload = { blocked: true };
      await guest.route(/\/api\/rec\/[^/]+\/upload/, (route) =>
        upload.blocked ? route.abort("failed") : route.fallback(),
      );
      await leave.click();
      await expect(
        guest.getByRole("heading", {
          name: /You left the room|didn't finish saving/,
        }),
      ).toBeVisible();

      await guestIsGone(take);
      await expect
        .poll(() => keeperSegmentWavBytes(guest, guestKeeper, 0), {
          timeout: 15_000,
        })
        .toBeGreaterThan(ONE_SECOND_KEEPER_WAV_BYTES);

      hostNet.restore();
      await expect
        .poll(() => hostRecordConnected(host, projectPath), { timeout: 30_000 })
        .toBe(true);
      await expect(roomTile(host, "Ava")).toContainText(/Left/);
      await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
      await expect(roomDlg.getByText(/Saving · \d of 2/).first()).toBeVisible({
        timeout: 20_000,
      });

      const saveButton = guest.getByRole("button", {
        name: "Save my recording",
      });
      await expect(saveButton).toBeVisible();
      const download = guest.waitForEvent("download");
      await saveButton.click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/\.(wav|zip)$/);

      upload.blocked = false;
      await waitForSegmentsAcked(host, projectPath, [take.guestId], {
        timeout: 90_000,
      });
      await expect(
        guest.getByRole("heading", { name: "You left the room" }),
      ).toBeVisible({ timeout: 30_000 });
    });
  });

  test("phone: the first press shows the warning, the second leaves once", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    await withLiveTake(browser, PHONE, async (take) => {
      const { guest } = take;
      const leave = leaveOf(guest);
      const dock = guest.locator(".sys-dock");
      const note = guest.locator(".sys-dock-hint");
      const heldDock = await boxOf(dock);

      await cutHost(take);
      await expect(leave).toHaveAttribute("aria-disabled", "true");

      await expect(leave).not.toHaveAttribute("aria-disabled", "true", {
        timeout: 75_000,
      });
      await expect(leave).toHaveAccessibleDescription(WARNING_SHORT);
      await expect(note).toBeHidden();
      const openDock = await boxOf(dock);
      expect(openDock.height).toBeCloseTo(heldDock.height, 0);

      await leave.tap();
      await expect(note).toBeVisible();
      await expect(note).toHaveText(WARNING_SHORT);
      await expect(roomPill(guest)).toHaveText(LIVE_PILL);

      await guest.setViewportSize({ width: 667, height: 375 });
      await expect(note).toBeHidden({ timeout: 10_000 });
      await leave.tap();
      await expect(note).toBeVisible();
      const bubble = await boxOf(note);
      expect(bubble.x).toBeGreaterThanOrEqual(0);
      expect(bubble.y).toBeGreaterThanOrEqual(0);
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(667);
      expect(bubble.y + bubble.height).toBeLessThanOrEqual(375);
      await expect(roomPill(guest)).toHaveText(LIVE_PILL);

      await guest.setViewportSize({ width: 390, height: 844 });
      await expect(note).toBeHidden({ timeout: 10_000 });
      await leave.tap();
      await expect(note).toBeVisible();
      await expect(
        guest.getByRole("heading", {
          name: /You left the room|didn't finish saving/,
        }),
      ).toBeHidden();
      await leave.tap();
      await expect(
        guest.getByRole("heading", {
          name: /You left the room|didn't finish saving/,
        }),
      ).toBeVisible();
      await guestIsGone(take);
    });
  });

  test("the host returning before a minute starts the wait over", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    await withLiveTake(browser, LAPTOP, async (take) => {
      const { guest, host, hostNet, projectPath } = take;
      const leave = leaveOf(guest);
      await cutHost(take);
      await expect(leave).toHaveAttribute("aria-disabled", "true");

      hostNet.restore();
      await expect
        .poll(() => hostRecordConnected(host, projectPath), { timeout: 30_000 })
        .toBe(true);
      await expect(guest.getByText(HOST_DROPPED)).toBeHidden({
        timeout: 15_000,
      });
      await expect(leave).toHaveAttribute("aria-disabled", "true");

      const secondDrop = await cutHost(take);
      await expect(leave).toHaveAttribute("aria-disabled", "true");
      await expect(leave).not.toHaveAttribute("aria-disabled", "true", {
        timeout: 75_000,
      });
      expect(Date.now() - secondDrop).toBeGreaterThanOrEqual(WAIT_MS - 1_000);
    });
  });

  test("the guest's own connection dropping starts the wait over", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    await withLiveTake(browser, LAPTOP, async (take) => {
      const { guest, guestNet } = take;
      const leave = leaveOf(guest);
      await cutHost(take);
      await expect(leave).toHaveAttribute("aria-disabled", "true");

      await guestNet.drop();
      await expect(roomPill(guest)).toHaveText(/Reconnecting/);
      guestNet.restore();
      await expect(roomPill(guest)).toHaveText(LIVE_PILL, {
        timeout: 30_000,
      });
      const back = Date.now();
      await expect(leave).toHaveAttribute("aria-disabled", "true");
      await expect(leave).not.toHaveAttribute("aria-disabled", "true", {
        timeout: 75_000,
      });
      expect(Date.now() - back).toBeGreaterThanOrEqual(WAIT_MS - 1_000);
    });
  });
});
