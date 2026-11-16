import fs from "node:fs";
import {
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { createRelocatedE2eProject } from "./liveProject";
import {
  createRecordRoom,
  ensureHostRecordCommand,
  joinAsGuest,
  joinAsProducer,
  markSharecutE2e,
  openHostRecordRoom,
  roomPill,
  roomTile,
} from "./recordRoom";
import { switchE2eProject, withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * The record room on a phone (issue 3834, PR 7): the episode title keeps two
 * lines in a 44 px header, every dock control is told apart by a word and a
 * 44 px target, tiles start under the header, and the guest's own tile reads
 * as theirs and leads to Devices. The laptop keeps its wordmark and dock.
 */

const { defaultBrowserType: _iphoneBrowser, ...iPhone } = devices["iPhone 13"];
const phoneAt = (width: number, height = 844): BrowserContextOptions => ({
  ...iPhone,
  viewport: { width, height },
});
const LAPTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  screen: { width: 1280, height: 800 },
};

const LONG_TITLE = "Aligned dialogue and the long road";
// 2.75rem is 44 px; a laid-out box can read a few millionths short in float.
const TOUCH_MIN = 43.99;
const THEMES = ["light", "dark"] as const;

test.use({
  launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] },
});

function titledProject(title: string) {
  return (prefix: string) => {
    const created = createRelocatedE2eProject(prefix);
    const project = JSON.parse(fs.readFileSync(created.projectPath, "utf8"));
    project.meta = { ...project.meta, name: title };
    fs.writeFileSync(created.projectPath, JSON.stringify(project, null, 2));
    return created;
  };
}

async function inRoom(
  browser: Browser,
  options: {
    guest?: BrowserContextOptions;
    title?: string;
  },
  run: (ctx: {
    host: Page;
    guest: Page;
    projectPath: string;
    room: Awaited<ReturnType<typeof createRecordRoom>>;
  }) => Promise<void>,
) {
  await withShareableProject(
    async (projectPath) => {
      await withBrowserPages(
        browser,
        [LAPTOP, options.guest ?? phoneAt(390)],
        async ([host, guest]) => {
          await markSharecutE2e(host!);
          await openProject(host!, projectPath, { query: "&e2e=1" });
          await expect(host!.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host!, projectPath);
          await openHostRecordRoom(host!);
          await markSharecutE2e(guest!);
          await run({ host: host!, guest: guest!, projectPath, room });
        },
      );
    },
    switchE2eProject,
    options.title ? titledProject(options.title) : undefined,
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as NonNullable<typeof found>;
}

const header = (page: Page) => page.locator(".sys-room-view-header");
const title = (page: Page) => page.getByRole("heading", { level: 1 });
const dockButtons = (page: Page) =>
  page.getByRole("group", { name: "Recording controls" }).getByRole("button");

async function expectTitleWhole(page: Page, text: string) {
  await expect(title(page)).toHaveText(text);
  const fit = await title(page).evaluate((h1) => ({
    clipped: h1.scrollHeight > h1.clientHeight + 1,
    width: h1.getBoundingClientRect().width,
  }));
  expect(fit.clipped, "title text is cut").toBe(false);
  expect(fit.width).toBeGreaterThanOrEqual(80);
  expect((await box(header(page))).height).toBeCloseTo(44, 0);
}

async function expectBrandSymbol(page: Page) {
  await expect(page.locator(".sys-room-view-symbol")).toBeVisible();
  await expect(page.locator(".sys-room-view-wordmark")).toBeHidden();
}

async function expectLabelledDock(page: Page) {
  const buttons = dockButtons(page);
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(1);
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    const target = await box(button);
    expect(target.width).toBeGreaterThanOrEqual(TOUCH_MIN);
    expect(target.height).toBeGreaterThanOrEqual(TOUCH_MIN);
    const name = (await button.getAttribute("aria-label")) ?? "";
    names.push(name || (await button.innerText()));
    expect(name).not.toMatch(/^Comments/);
    if (!(await button.evaluate((b) => b.matches(".sys-dock-done")))) {
      await expect(button.locator(".sys-dock-label")).toBeVisible();
    }
  }
  expect(new Set(names).size).toBe(names.length);
  await expect(page.getByRole("button", { name: /^Comments/ })).toHaveCount(1);
  await expect(page.locator(".sys-room-view-peek")).toBeVisible();
}

async function expectTilesUnderHeader(page: Page) {
  const top = (await box(page.locator(".sys-room-tile").first())).y;
  const bottom = (await box(header(page))).y + (await box(header(page))).height;
  expect(top - bottom).toBeLessThanOrEqual(25);
}

async function expectOwnTile(page: Page, name: string) {
  const tile = roomTile(page, name);
  await expect(tile).toHaveAccessibleName(new RegExp(`^${name}, you`));
  await expect(tile.getByText("(you)")).toBeVisible();
  await expect(tile.getByText("Devices")).toBeVisible();
}

async function expectPhoneRoom(page: Page, titleText: string, width: number) {
  expect(await page.evaluate(() => innerWidth)).toBe(width);
  for (const scheme of THEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectTitleWhole(page, titleText);
    await expectBrandSymbol(page);
    await expectLabelledDock(page);
    await expectTilesUnderHeader(page);
  }
}

test.describe("record room on a phone", () => {
  test("390: every state keeps the title, the labelled dock, top tiles and the own tile", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { title: LONG_TITLE },
      async ({ host, guest, projectPath, room }) => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        await guest.context().route(/\/api\/rec\/[^/]+\/upload/, async (r) => {
          if (r.request().method() === "POST") await gate;
          await r.continue();
        });
        await joinAsGuest(guest, room.guest.token, "Ava");

        await expectPhoneRoom(guest, LONG_TITLE, 390);
        await expectOwnTile(guest, "Ava");
        const pillWaiting = await box(roomPill(guest));
        expect(pillWaiting.x + pillWaiting.width).toBeLessThanOrEqual(390);

        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expect(roomPill(guest)).toHaveText(/^\d+:\d{2} · Take \d+$/);
        await expectPhoneRoom(guest, LONG_TITLE, 390);
        await expectOwnTile(guest, "Ava");
        await roomTile(guest, "Ava").getByRole("button").tap();
        await expect(
          guest.getByRole("dialog", { name: "Devices" }),
        ).toBeVisible();
        await guest.keyboard.press("Escape");
        await expect(
          guest.getByRole("dialog", { name: "Devices" }),
        ).toBeHidden();

        const leave = guest.getByRole("button", { name: "Leave room" });
        await expect(leave).toHaveAttribute("aria-disabled", "true");
        await expect(leave.locator(".sys-dock-label")).toBeVisible();
        // Playwright treats aria-disabled as not enabled; a held Leave stays pressable on purpose.
        await leave.tap({ force: true });
        await expect(
          guest.getByText("You can leave after this take."),
        ).toBeVisible();

        await ensureHostRecordCommand(host, projectPath, "Pause", "paused");
        await expect(roomPill(guest)).toContainText(/Paused/);
        await expectPhoneRoom(guest, LONG_TITLE, 390);

        await ensureHostRecordCommand(host, projectPath, "Resume", "recording");
        await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
        await expect(roomPill(guest)).toHaveText(/Saving/);
        await expectPhoneRoom(guest, LONG_TITLE, 390);

        release();
        await expect(roomPill(guest)).toHaveText("Saved", { timeout: 60_000 });
        await expectTitleWhole(guest, LONG_TITLE);
        await expectBrandSymbol(guest);
        await expectTilesUnderHeader(guest);
        const done = guest.getByRole("button", { name: "Done" });
        expect((await box(done)).height).toBeGreaterThanOrEqual(TOUCH_MIN);
        await expect(
          guest.getByRole("button", { name: /^Comments/ }),
        ).toHaveCount(1);
      },
    );
  });

  for (const width of [320, 599]) {
    test(`${width} wide: the short title is whole and the targets hold`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      await inRoom(
        browser,
        { guest: phoneAt(width, 900) },
        async ({ guest, room }) => {
          await joinAsGuest(guest, room.guest.token, "Ava");
          await expectPhoneRoom(guest, "aligned dialogue", width);
          await expectOwnTile(guest, "Ava");
        },
      );
    });
  }

  test("a producer's phone dock is Comment and Leave, labelled, with the peek as the door", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { guest: phoneAt(390) },
      async ({ host, guest, projectPath, room }) => {
        await joinAsProducer(guest, room.producer.token, "Pat");
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expect(roomPill(guest)).toHaveText(/^\d+:\d{2} · Take \d+$/);
        await expectBrandSymbol(guest);
        await expectLabelledDock(guest);
        await expect(dockButtons(guest)).toHaveText(["Comment", "Leave"]);
      },
    );
  });

  test("1280: the guest keeps the wordmark and the Comments toggle, tiles stay centred, own tile reads you", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await inRoom(browser, { guest: LAPTOP }, async ({ guest, room }) => {
      await joinAsGuest(guest, room.guest.token, "Ava");
      await expect(page(guest).wordmark).toBeVisible();
      await expect(page(guest).symbol).toBeHidden();
      await expect(
        guest.getByRole("button", { name: "Comments", exact: true }),
      ).toBeVisible();
      await expect(guest.locator(".sys-dock-label")).toHaveCount(0);
      const tileTop = (await box(guest.locator(".sys-room-tile").first())).y;
      const headerBottom =
        (await box(header(guest))).y + (await box(header(guest))).height;
      expect(tileTop - headerBottom).toBeGreaterThan(100);
      await expectOwnTile(guest, "Ava");
    });
  });
});

function page(p: Page) {
  return {
    wordmark: p.locator(".sys-room-view-wordmark"),
    symbol: p.locator(".sys-room-view-symbol"),
  };
}
