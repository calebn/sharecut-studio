import {
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  createRecordRoom,
  ensureHostRecordCommand,
  fillDisplayNameField,
  markSharecutE2e,
  openHostRecordRoom,
  openRecordLink,
  roomPill,
  roomTile,
} from "./recordRoom";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * Headphones in the record room: a phone (coarse primary pointer, screen short
 * side under 600) answers wearing or not wearing, and the host's tile for that
 * guest shows it; every other device keeps the one toggle and the gate.
 */

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];
const { defaultBrowserType: _padBrowser, ...iPadMini } = {
  ...devices["iPad Mini"],
  screen: { width: 768, height: 1024 },
};

const LAPTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  screen: { width: 1280, height: 800 },
};
const HOST = LAPTOP;
const NOT_WEARING = "I'm not wearing headphones";
const WEARING = "I'm wearing headphones";
const NOTE =
  "Without headphones, the others may hear an echo and be heard in your recording. Keep your volume low.";
const MARKER = /not wearing headphones/;

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

async function environment(page: Page) {
  return page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    shortSide: Math.min(screen.width, screen.height),
  }));
}

async function createRecordRoomFor(host: Page, projectPath: string) {
  await markSharecutE2e(host);
  await openProject(host, projectPath, { query: "&e2e=1" });
  await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
  return createRecordRoom(host, projectPath);
}

async function openHost(host: Page, projectPath: string) {
  const room = await createRecordRoomFor(host, projectPath);
  await openHostRecordRoom(host);
  return room;
}

async function phoneGuestAtHeadphones(
  guest: Page,
  token: string,
  name: string,
) {
  await markSharecutE2e(guest);
  await openRecordLink(guest, token);
  expect(await environment(guest)).toEqual({ coarse: true, shortSide: 390 });
  await fillDisplayNameField(guest, name);
  await guest.getByRole("button", { name: "Allow microphone" }).click();
  await expect(guest.getByRole("button", { name: NOT_WEARING })).toBeVisible();
}

async function join(guest: Page, name: string) {
  await guest.getByRole("button", { name: "Join and record" }).click();
  await expect(roomPill(guest)).toHaveText(/^Waiting for .+ to start$/);
  await expect(roomTile(guest, name)).toBeVisible();
}

test.describe("headphones in the record room", () => {
  test("a phone guest joins without headphones after a choice and the host sees it until they switch", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [HOST, iPhone], async ([host, guest]) => {
        const room = await openHost(host as Page, projectPath);
        const phone = guest as Page;
        await phoneGuestAtHeadphones(phone, room.guest.token, "Maya");
        const wearing = phone.getByRole("button", { name: WEARING });
        const notWearing = phone.getByRole("button", { name: NOT_WEARING });
        await expect(wearing).toHaveAttribute("aria-pressed", "false");
        await expect(notWearing).toHaveAttribute("aria-pressed", "false");
        const joinButton = phone.getByRole("button", {
          name: "Join and record",
        });
        await expect(joinButton).toBeDisabled();
        await expect(joinButton).toHaveAccessibleDescription(
          "Say if you're wearing headphones first",
        );
        await notWearing.click();
        await expect(notWearing).toHaveAttribute("aria-pressed", "true");
        await expect(phone.getByText(NOTE)).toBeVisible();
        await expect(joinButton).toBeEnabled();
        await join(phone, "Maya");

        await expect(roomTile(host as Page, "Maya")).toHaveAccessibleName(
          MARKER,
        );
        await expect(roomTile(phone, "Maya")).toHaveAccessibleName(MARKER);

        await phone.getByRole("button", { name: "Devices" }).click();
        const sheet = phone.getByRole("dialog", { name: "Devices" });
        await expect(sheet.getByText(NOTE)).toBeVisible();
        await sheet.getByRole("button", { name: WEARING }).click();
        await expect(sheet.getByText(NOTE)).toHaveCount(0);
        await expect
          .poll(async () =>
            roomTile(host as Page, "Maya").getAttribute("aria-label"),
          )
          .not.toMatch(MARKER);
      });
    });
  });

  test("a reload mid-take keeps what the guest said", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(
        browser,
        [HOST, iPhone, iPhone],
        async ([host, yes, no]) => {
          const room = await openHost(host as Page, projectPath);
          const saidYes = yes as Page;
          const saidNo = no as Page;
          await phoneGuestAtHeadphones(saidYes, room.guest.token, "Yara");
          await saidYes.getByRole("button", { name: WEARING }).click();
          await join(saidYes, "Yara");
          await phoneGuestAtHeadphones(saidNo, room.guest.token, "Noor");
          await saidNo.getByRole("button", { name: NOT_WEARING }).click();
          await join(saidNo, "Noor");
          await ensureHostRecordCommand(
            host as Page,
            projectPath,
            "Start",
            "recording",
          );

          await saidYes.reload();
          await saidNo.reload();
          await expect(roomTile(saidYes, "Yara")).toBeVisible();
          await expect(roomTile(saidNo, "Noor")).toBeVisible();
          await expect(roomTile(host as Page, "Noor")).toHaveAccessibleName(
            MARKER,
          );
          await expect(roomTile(host as Page, "Yara")).toBeVisible();
          await expect(roomTile(host as Page, "Yara")).not.toHaveAccessibleName(
            MARKER,
          );
        },
      );
    });
  });

  const GATED: {
    name: string;
    options: BrowserContextOptions;
    expected: { coarse: boolean; shortSide: number };
  }[] = [
    {
      name: "a laptop",
      options: HOST,
      expected: { coarse: false, shortSide: 800 },
    },
    {
      name: "a narrow laptop window on a small screen",
      options: {
        viewport: { width: 500, height: 800 },
        screen: { width: 500, height: 800 },
      },
      expected: { coarse: false, shortSide: 500 },
    },
    {
      name: "a narrow laptop window on a large screen",
      options: {
        viewport: { width: 500, height: 800 },
        screen: { width: 1440, height: 900 },
      },
      expected: { coarse: false, shortSide: 900 },
    },
    {
      name: "a touch laptop",
      options: { ...LAPTOP, hasTouch: true },
      expected: { coarse: true, shortSide: 800 },
    },
    {
      name: "a tablet",
      options: iPadMini,
      expected: { coarse: true, shortSide: 768 },
    },
  ];

  for (const { name, options, expected } of GATED) {
    test(`${name} keeps the one toggle and the gate`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      await withShareableProject(async (projectPath) => {
        await withBrowserPages(
          browser,
          [HOST, options],
          async ([host, guest]) => {
            const room = await createRecordRoomFor(host as Page, projectPath);
            const page = guest as Page;
            await markSharecutE2e(page);
            await openRecordLink(page, room.guest.token);
            expect(await environment(page)).toEqual(expected);
            await fillDisplayNameField(page, "Lena");
            await page
              .getByRole("button", { name: "Allow microphone" })
              .click();
            await expect(
              page.getByRole("button", { name: WEARING }),
            ).toBeVisible();
            await expect(
              page.getByRole("button", { name: NOT_WEARING }),
            ).toHaveCount(0);
            await expect(
              page.getByRole("button", { name: "Join and record" }),
            ).toHaveAccessibleDescription("Put on headphones first");
          },
        );
      });
    });
  }
});
