import fs from "node:fs";
import {
  type Browser,
  type BrowserContextOptions,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  driveKeepAlive,
  fireOsAction,
  installOsRecorder,
  type OsRecorderSnapshot,
  readOsRecorder,
  suspendContext,
} from "./osMediaSessionRecorder";
import { withShareableProject } from "./shareableProject";
import { createReviewShare, openGuestShare } from "./shareNavigation";
import { parseTimecodeSec } from "./timecode";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * What a guest share link tells the OS media controls (#3785). The device
 * descriptors change the user agent, viewport and touch only: they prove what
 * the page registers and that every OS action drives the real transport, not
 * what iOS or Android draw on the lock screen.
 */

const DURATION_SEC = 60;
const SKIP_SEC = 15;
const NEAR_SEC = 1;

const { defaultBrowserType: _pixelEngine, ...pixel7 } = devices["Pixel 7"];
const { defaultBrowserType: _iphoneEngine, ...iphone15Pro } =
  devices["iPhone 15 Pro"];
const PHONES: ReadonlyArray<[string, BrowserContextOptions]> = [
  ["Pixel 7", pixel7],
  ["iPhone 15 Pro", iphone15Pro],
];

/** The Player clock in seconds; the Player shows it in the bar or the expanded form. */
function playerSec(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const node = [...document.querySelectorAll(".sys-player-now")].find(
        (el) => el.getBoundingClientRect().width > 0,
      );
      return node?.textContent ?? "";
    })
    .then(parseTimecodeSec);
}

const lastPosition = (snapshot: OsRecorderSnapshot) =>
  snapshot.positionStates.at(-1);
const keepAlive = (snapshot: OsRecorderSnapshot) =>
  snapshot.media.find((media) => media.src.startsWith("blob:"));

async function withPhoneGuest(
  browser: Browser,
  phone: BrowserContextOptions,
  run: (page: Page, title: string) => Promise<void>,
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    const title = (
      JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
        meta: { name: string };
      }
    ).meta.name;
    await withBrowserPages(browser, [{}, phone], async ([host, page]) => {
      await installOsRecorder(page!);
      const token = await createReviewShare(host!, projectPath, "commenter");
      await openGuestShare(page!, token);
      await run(page!, title);
    });
  });
}

const play = (page: Page) =>
  page.getByRole("button", { name: "Play", exact: true }).first();
const pause = (page: Page) =>
  page.getByRole("button", { name: "Pause", exact: true }).first();

for (const [deviceName, phone] of PHONES) {
  test.describe(`guest OS media session on ${deviceName}`, () => {
    test("claims nothing before Play, then projects the transport", async ({
      browser,
    }) => {
      await withPhoneGuest(browser, phone, async (page, title) => {
        await expect
          .poll(async () => (await readOsRecorder(page)).metadata)
          .not.toBeNull();
        const idle = await readOsRecorder(page);
        expect(idle.metadata).toEqual({ title, artist: "", album: "" });
        expect(idle.playbackState).toBe("paused");
        expect(idle.handlers).toEqual({
          play: "fn",
          pause: "fn",
          seekbackward: "fn",
          seekforward: "fn",
          seekto: "fn",
          previoustrack: null,
          nexttrack: null,
        });
        expect(idle.media.filter((media) => media.src !== "")).toEqual([]);

        await play(page).tap();
        await expect(pause(page)).toBeVisible();
        await expect
          .poll(async () => (await readOsRecorder(page)).playbackState)
          .toBe("playing");
        const playing = await readOsRecorder(page);
        expect(lastPosition(playing)).toEqual({
          duration: DURATION_SEC,
          playbackRate: 1,
          position: expect.closeTo(0, 0),
        });
        await expect
          .poll(async () => keepAlive(await readOsRecorder(page))?.duration)
          .toBeGreaterThan(5);
        const element = keepAlive(await readOsRecorder(page));
        expect(element).toMatchObject({
          paused: false,
          loop: true,
          muted: false,
          error: null,
        });
        expect(playing.violations).toEqual([]);

        const calls = playing.positionStates.length;
        await page.waitForTimeout(3000);
        expect((await readOsRecorder(page)).positionStates.length).toBe(calls);
      });
    });

    test("lock-screen pause, play and seeks drive the transport", async ({
      browser,
    }) => {
      await withPhoneGuest(browser, phone, async (page) => {
        await play(page).tap();
        await expect(pause(page)).toBeVisible();
        await page.waitForTimeout(1500);

        await fireOsAction(page, "pause");
        await expect(play(page)).toBeVisible();
        await expect
          .poll(async () => (await readOsRecorder(page)).contexts)
          .toEqual(["suspended"]);
        const paused = await readOsRecorder(page);
        expect(paused.playbackState).toBe("paused");
        expect(keepAlive(paused)?.paused).toBe(true);
        const heldAt = await playerSec(page);
        expect(lastPosition(paused)?.position).toBeCloseTo(heldAt, 0);

        await fireOsAction(page, "play");
        await expect(pause(page)).toBeVisible();
        await expect
          .poll(async () => (await readOsRecorder(page)).contexts)
          .toEqual(["running"]);
        expect(keepAlive(await readOsRecorder(page))?.paused).toBe(false);

        await fireOsAction(page, "pause");
        await expect(play(page)).toBeVisible();
        const before = await playerSec(page);
        await fireOsAction(page, "seekforward", { seekOffset: 10 });
        await expect.poll(() => playerSec(page)).toBeCloseTo(before + 10, 0);
        await fireOsAction(page, "seekforward");
        await expect
          .poll(() => playerSec(page))
          .toBeCloseTo(before + 10 + SKIP_SEC, 0);
        await fireOsAction(page, "seekbackward");
        await expect.poll(() => playerSec(page)).toBeCloseTo(before + 10, 0);

        await fireOsAction(page, "seekto", { seekTime: 40 });
        await expect.poll(() => playerSec(page)).toBeCloseTo(40, 0);
        expect(lastPosition(await readOsRecorder(page))).toEqual({
          duration: DURATION_SEC,
          playbackRate: 1,
          position: 40,
        });
      });
    });

    test("a locked page keeps the listener's place", async ({ browser }) => {
      await withPhoneGuest(browser, phone, async (page) => {
        await play(page).tap();
        await expect(pause(page)).toBeVisible();
        await page.waitForTimeout(1000);
        await page.evaluate(() => {
          window.requestAnimationFrame = () => 1;
        });
        await page.waitForTimeout(500);
        const frozenAt = await playerSec(page);
        await page.waitForTimeout(5000);
        await fireOsAction(page, "seekforward");
        const landed = await playerSec(page);
        expect(landed).toBeGreaterThan(frozenAt + 5 + SKIP_SEC - NEAR_SEC);
        expect(landed).toBeLessThan(frozenAt + 5 + SKIP_SEC + 2 * NEAR_SEC);

        await page.waitForTimeout(2000);
        await fireOsAction(page, "pause");
        await expect(play(page)).toBeVisible();
        expect(await playerSec(page)).toBeGreaterThan(landed + 1.5);
      });
    });

    test("the OS pausing the keep-alive or the audio context pauses the app", async ({
      browser,
    }) => {
      await withPhoneGuest(browser, phone, async (page) => {
        await play(page).tap();
        await expect(pause(page)).toBeVisible();
        await expect
          .poll(async () => keepAlive(await readOsRecorder(page))?.paused)
          .toBe(false);

        await driveKeepAlive(page, "pause");
        await expect(play(page)).toBeVisible();
        expect((await readOsRecorder(page)).playbackState).toBe("paused");

        await driveKeepAlive(page, "play");
        await expect(pause(page)).toBeVisible();
        await expect
          .poll(async () => (await readOsRecorder(page)).contexts)
          .toEqual(["running"]);

        await suspendContext(page);
        await expect(play(page)).toBeVisible();
        expect(keepAlive(await readOsRecorder(page))?.paused).toBe(true);
      });
    });
  });
}
