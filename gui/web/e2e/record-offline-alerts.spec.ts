import { type Browser, expect, type Page, test } from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  LAPTOP,
  LIVE_PILL,
  type LiveTake,
  PHONE,
  withLiveTake,
} from "./recordLiveTake";
import {
  ensureHostRecordCommand,
  expectNoRoomAlert,
  expectRoomAlert,
  roomAlertSlot,
  roomPill,
} from "./recordRoom";

const CONNECTION_LOST =
  "Lost connection to the room. You're still recording on this device.";
const SAVING_STOPPED = "Saving stopped.";
const TICKS = 5;
const TICK_MS = 2_000;

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

async function expectOnlyConnectionAlert(page: Page) {
  await expectRoomAlert(page, CONNECTION_LOST);
  for (let tick = 0; tick < TICKS; tick += 1) {
    await page.waitForTimeout(TICK_MS);
    await expect(roomAlertSlot(page).getByText(SAVING_STOPPED)).toHaveCount(0);
    await expect(
      roomAlertSlot(page).getByRole("button", { name: /^\d+ more alerts?$/ }),
    ).toHaveCount(0);
  }
}

async function failUploads(page: Page) {
  const state = { failing: false };
  await page.route(/\/api\/rec\/[^/]+\/upload/, (route) =>
    state.failing ? route.abort("failed") : route.fallback(),
  );
  return state;
}

for (const [name, options] of [
  ["laptop", LAPTOP],
  ["phone", PHONE],
] as const) {
  test(`${name}: a dropped guest connection shows one alert, and a real failure comes back after it`, async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    await withLiveTake(browser, options, async ({ guest, guestNet }) => {
      const uploads = await failUploads(guest);
      uploads.failing = true;
      await expectRoomAlert(guest, SAVING_STOPPED);
      await expectNoRoomAlert(guest, CONNECTION_LOST);

      await guestNet.drop();
      await expect(roomPill(guest)).toHaveText(/Reconnecting/);
      await expectOnlyConnectionAlert(guest);

      guestNet.restore();
      await expect(roomPill(guest)).toHaveText(LIVE_PILL, { timeout: 30_000 });
      await expectNoRoomAlert(guest, CONNECTION_LOST);
      await expectRoomAlert(guest, SAVING_STOPPED);
    });
  });
}

test("a drop with a healthy upload shows the connection alert alone, and it clears when back", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.setTimeout(180_000);
  await withLiveTake(browser, LAPTOP, async ({ guest, guestNet }) => {
    await guestNet.drop();
    await expectOnlyConnectionAlert(guest);
    guestNet.restore();
    await expect(roomPill(guest)).toHaveText(LIVE_PILL, { timeout: 30_000 });
    await expectNoRoomAlert(guest, CONNECTION_LOST);
    await expect(roomAlertSlot(guest).getByText(SAVING_STOPPED)).toHaveCount(0);
  });
});

test("a saved guest sees no alert when the connection drops", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.setTimeout(240_000);
  await withLiveTake(browser, LAPTOP, async (take: LiveTake) => {
    const { guest, host, projectPath, guestNet } = take;
    await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
    await expect(roomPill(guest)).toHaveText("Saved", { timeout: 60_000 });
    await guestNet.drop();
    for (let tick = 0; tick < TICKS; tick += 1) {
      await guest.waitForTimeout(TICK_MS);
      await expect(roomAlertSlot(guest).getByText(SAVING_STOPPED)).toHaveCount(
        0,
      );
    }
    await expect(roomPill(guest)).toHaveText("Saved");
  });
});

test("a paused take keeps its alerts: no connection alert, and saving stopped only because uploads did stop", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.setTimeout(240_000);
  await withLiveTake(browser, LAPTOP, async (take: LiveTake) => {
    const { guest, host, projectPath, guestNet } = take;
    await ensureHostRecordCommand(host, projectPath, "Pause", "paused");
    await expect(roomPill(guest)).toContainText(/Paused/);
    await guestNet.drop();
    await expectRoomAlert(guest, SAVING_STOPPED);
    await expectNoRoomAlert(guest, CONNECTION_LOST);
    guestNet.restore();
    await expect(roomAlertSlot(guest).getByText(SAVING_STOPPED)).toHaveCount(
      0,
      {
        timeout: 30_000,
      },
    );
  });
});
