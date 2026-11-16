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
 * The laptop and the host studio on a phone must keep their old header, grid
 * and dock, so every phone rule is checked next to what it must not change.
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
    host?: BrowserContextOptions;
    /** Other guests who join first, so the room holds the host, them and the viewer. */
    crowd?: string[];
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
        [
          options.host ?? LAPTOP,
          options.guest ?? phoneAt(390),
          ...(options.crowd ?? []).map(() => LAPTOP),
        ],
        async ([host, guest, ...others]) => {
          await markSharecutE2e(host!);
          await openProject(host!, projectPath, { query: "&e2e=1" });
          await expect(host!.getByRole("heading", { level: 1 })).toBeVisible();
          const room = await createRecordRoom(host!, projectPath);
          await openHostRecordRoom(host!);
          await markSharecutE2e(guest!);
          for (const [index, name] of (options.crowd ?? []).entries()) {
            await markSharecutE2e(others[index]!);
            await joinAsGuest(others[index]!, room.guest.token, name);
          }
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
  const name = page.locator(".brand-lockup-name");
  await expect(name).toHaveText("ShareCut");
  expect(
    await name.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    }),
    "the name stays in the accessibility tree",
  ).toBe(true);
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
  if (
    (await page
      .locator(".sys-dock-status, .sys-dock-hint[data-shown]")
      .count()) === 0
  ) {
    // 1 border + 8 padding + 64 disc + 4 gap + 16 word + 8 padding.
    expect((await box(page.locator(".sys-dock"))).height).toBeCloseTo(101, 0);
  }
}

async function expectTilesUnderHeader(page: Page) {
  const top = (await box(page.locator(".sys-room-tile").first())).y;
  const bottom = (await box(header(page))).y + (await box(header(page))).height;
  expect(top - bottom).toBeLessThanOrEqual(25);
}

/** The level ring grows to 8 px past the avatar when the guest speaks. */
const RING_PX = 8;

async function expectCueClearsAvatar(page: Page) {
  const cue = page.locator(".sys-room-devices");
  if ((await cue.count()) === 0 || !(await cue.isVisible())) return;
  const cueBox = await box(cue);
  const face = await box(roomTile(page, "Ava").locator(".sys-room-face"));
  expect(
    face.y - (cueBox.y + cueBox.height),
    "the Devices cue clears the avatar and its level ring",
  ).toBeGreaterThanOrEqual(RING_PX);
}

async function expectOwnTile(page: Page, name: string) {
  const tile = roomTile(page, name);
  await expect(tile).toHaveAccessibleName(new RegExp(`^${name}, you`));
  await expect(tile.getByText("(you)")).toBeVisible();
  await expect(tile.getByText("Devices")).toBeVisible();
}

async function expectPhoneRoom(page: Page, titleText: string, width: number) {
  expect(await page.evaluate(() => innerWidth)).toBe(width);
  await expectTitleWhole(page, titleText);
  await expectBrandSymbol(page);
  await expectLabelledDock(page);
  await expectTilesUnderHeader(page);
  await expectCueClearsAvatar(page);
}

test.describe("record room on a phone", () => {
  for (const [width, titleText] of [
    [390, LONG_TITLE],
    [320, "aligned dialogue"],
  ] as const) {
    test(`${width}: every state keeps the title, the labelled dock, top tiles and the own tile`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      test.slow();
      await inRoom(
        browser,
        {
          guest: phoneAt(width, width === 320 ? 640 : 844),
          title: width === 390 ? LONG_TITLE : undefined,
        },
        async ({ host, guest, projectPath, room }) => {
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          await guest
            .context()
            .route(/\/api\/rec\/[^/]+\/upload/, async (r) => {
              if (r.request().method() === "POST") await gate;
              await r.continue();
            });
          // Layout does not change with the theme; this walk runs in the dark one.
          await guest.emulateMedia({ colorScheme: "dark" });
          await joinAsGuest(guest, room.guest.token, "Ava");

          await expectPhoneRoom(guest, titleText, width);
          await expectOwnTile(guest, "Ava");
          const pillWaiting = await box(roomPill(guest));
          expect(pillWaiting.x + pillWaiting.width).toBeLessThanOrEqual(width);

          await ensureHostRecordCommand(
            host,
            projectPath,
            "Start",
            "recording",
          );
          await expect(roomPill(guest)).toHaveText(/^\d+:\d{2} · Take \d+$/);
          await expectPhoneRoom(guest, titleText, width);
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
          await expectPhoneRoom(guest, titleText, width);

          await ensureHostRecordCommand(
            host,
            projectPath,
            "Resume",
            "recording",
          );
          await ensureHostRecordCommand(host, projectPath, "Stop", "stopped");
          await expect(roomPill(guest)).toHaveText(/Saving/);
          await expectPhoneRoom(guest, titleText, width);

          release();
          await expect(roomPill(guest)).toHaveText("Saved", {
            timeout: 60_000,
          });
          await expectTitleWhole(guest, titleText);
          await expectBrandSymbol(guest);
          await expectTilesUnderHeader(guest);
          await expectCueClearsAvatar(guest);
          const done = guest.getByRole("button", { name: "Done" });
          expect((await box(done)).height).toBeGreaterThanOrEqual(TOUCH_MIN);
          await expect(
            guest.getByRole("button", { name: /^Comments/ }),
          ).toHaveCount(1);
        },
      );
    });
  }

  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [667, 375],
    [568, 320],
  ] as const) {
    test(`${width}x${height} with four people: the Devices cue never meets the avatar`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      test.slow();
      await inRoom(
        browser,
        { guest: phoneAt(width, height), crowd: ["Bo", "Cy"] },
        async ({ host, guest, projectPath, room }) => {
          await joinAsGuest(guest, room.guest.token, "Ava");
          expect(await guest.locator(".sys-room-tile").count()).toBe(4);
          const landscape = width > height;
          await expect(guest.locator(".sys-room-view")).toHaveAttribute(
            "data-width",
            landscape ? "phone-landscape" : "phone",
          );
          for (const phase of ["waiting", "live"]) {
            if (phase === "live") {
              await ensureHostRecordCommand(
                host,
                projectPath,
                "Start",
                "recording",
              );
              await expect(roomPill(guest)).toHaveText(
                /^\d+:\d{2} · Take \d+$/,
              );
            }
            await expect(
              roomTile(guest, "Ava").getByText("(you)"),
            ).toBeVisible();
            if (landscape) {
              // The tiles are too small for a cue beside the avatar.
              await expect(guest.locator(".sys-room-devices")).toBeHidden();
            } else {
              await expect(guest.locator(".sys-room-devices")).toBeVisible();
            }
            await expectCueClearsAvatar(guest);
          }
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

  test("the host studio on a phone keeps its own header, dock and centred tiles", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    await inRoom(
      browser,
      { host: phoneAt(390) },
      async ({ host, guest, room }) => {
        await joinAsGuest(guest, room.guest.token, "Ava");
        const view = host.locator(".sys-room-view[data-embedded]");
        await expect(view).toBeVisible();
        await expect(view.locator(".sys-dock-label")).toHaveCount(0);
        await expect(view.locator(".sys-room-view-symbol")).toHaveCount(0);
        await expect(view.locator(".sys-room-devices")).toHaveCount(0);
        const gap = await view
          .locator(".sys-room-view-grid")
          .evaluate((grid) =>
            Number.parseFloat(getComputedStyle(grid).marginTop),
          );
        expect(
          gap,
          "the host grid keeps its vertical centring",
        ).toBeGreaterThan(0);
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
