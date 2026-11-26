import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { hostList } from "./guestLink";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { LAPTOP, PHONE, withLiveTake } from "./recordLiveTake";
import {
  createRecordRoom,
  joinAsGuest,
  markSharecutE2e,
  recordParticipantId,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { goToStage, openProject, openProjectDialog } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

/*
 * Invite's End room follows the End session gate: it waits while a take could
 * be lost, asks when someone is in the room, and otherwise acts at once. After
 * an end the Record stage shows "No record room yet" without a reload.
 */

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

const TOUCH_MIN = 43.99;
const toast = (page: Page) => page.locator(".ui-toast-region--app .ui-toast");

async function liveRooms(page: Page, projectPath: string) {
  return (await hostList(page, projectPath))
    .filter((row) => row.usable)
    .map((row) => row.session_id);
}

async function openInvite(page: Page): Promise<Locator> {
  await openProjectDialog(page, "share");
  const sheet = page.getByRole("dialog", { name: "Invite" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Looking for your links…")).toBeHidden();
  return sheet;
}

async function tapOrClick(target: Locator, touch: boolean) {
  if (touch) await target.tap();
  else await target.click();
}

async function expectTouchTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(TOUCH_MIN);
  expect(box!.width).toBeGreaterThanOrEqual(TOUCH_MIN);
}

function idleEnd(
  label: string,
  hostOptions: BrowserContextOptions,
  touch: boolean,
) {
  test(`${label}: ending an idle room clears the Record stage with no reload, and Undo brings it back`, async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [hostOptions], async ([host]) => {
        await markSharecutE2e(host!);
        await openProject(host!, projectPath, { query: "&e2e=1" });
        const room = await createRecordRoom(host!, projectPath);
        await goToStage(host!, "record");
        await expect(
          host!.getByRole("button", { name: "Record", exact: true }),
        ).toBeVisible();

        const sheet = await openInvite(host!);
        const end = sheet.getByRole("button", { name: "End room" });
        await expect(end).toBeEnabled();
        if (touch) await expectTouchTarget(end);
        await tapOrClick(end, touch);
        await expect(toast(host!)).toContainText("Room ended.");
        expect(await liveRooms(host!, projectPath)).toEqual([]);
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        await expect(host!.getByText("No record room yet")).toBeVisible();
        await expect(
          host!.getByRole("button", { name: "Record", exact: true }),
        ).toHaveCount(0);

        await tapOrClick(
          toast(host!).getByRole("button", { name: "Undo" }),
          touch,
        );
        await expect(toast(host!)).toContainText("Room restored.");
        expect(await liveRooms(host!, projectPath)).toContain(room.session_id);
        await expect(host!.getByText("No record room yet")).toBeHidden();
        await expect(
          host!.getByRole("button", { name: "Record", exact: true }),
        ).toBeVisible();
      });
    });
  });
}

function lobbyGuest(
  label: string,
  hostOptions: BrowserContextOptions,
  touch: boolean,
) {
  test(`${label}: a guest in the lobby makes End room ask, Keep keeps, Escape keeps`, async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [hostOptions, LAPTOP],
        async ([host, guest]) => {
          await markSharecutE2e(host!);
          await openProject(host!, projectPath, { query: "&e2e=1" });
          const room = await createRecordRoom(host!, projectPath);
          await goToStage(host!, "record");
          await markSharecutE2e(guest!);
          await joinAsGuest(guest!, room.guest.token, "Ava");
          await recordParticipantId(host!, projectPath, "Ava");

          const sheet = await openInvite(host!);
          const end = sheet.getByRole("button", { name: "End room" });
          const prompt = sheet.getByText("End the room? Ava is sent out.");

          await tapOrClick(end, touch);
          await expect(prompt).toBeVisible();
          const keep = sheet.getByRole("button", { name: "Keep room" });
          await expect(keep).toBeFocused();
          if (touch) {
            await expectTouchTarget(keep);
            await expectTouchTarget(
              sheet.getByRole("button", { name: "End room" }),
            );
          }
          await tapOrClick(keep, touch);
          await expect(prompt).toBeHidden();
          await expect(end).toBeFocused();
          expect(await liveRooms(host!, projectPath)).toContain(
            room.session_id,
          );

          await tapOrClick(end, touch);
          await expect(prompt).toBeVisible();
          await host!.keyboard.press("Escape");
          await expect(prompt).toBeHidden();
          await expect(sheet).toBeVisible();
          expect(await liveRooms(host!, projectPath)).toContain(
            room.session_id,
          );

          await tapOrClick(end, touch);
          await tapOrClick(
            sheet.getByRole("button", { name: "End room" }),
            touch,
          );
          await expect(toast(host!)).toContainText("Room ended.");
          expect(await liveRooms(host!, projectPath)).toEqual([]);
        },
      );
    });
  });
}

test.describe("End room from Invite", () => {
  idleEnd("laptop", LAPTOP, false);
  idleEnd("iPhone touch", PHONE, true);
  lobbyGuest("laptop", LAPTOP, false);
  lobbyGuest("iPhone touch", PHONE, true);

  test("during a live take End room is disabled and says why", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await withLiveTake(browser, LAPTOP, async ({ host, projectPath, room }) => {
      const sheet = await openInvite(host);
      const end = sheet.getByRole("button", { name: "End room" });
      await expect(end).toBeDisabled();
      await expect(sheet.getByText("Stop the take first.")).toBeVisible();
      await expect(end).toHaveAccessibleDescription("Stop the take first.");
      expect(await liveRooms(host, projectPath)).toContain(room.session_id);
    });
  });
});
