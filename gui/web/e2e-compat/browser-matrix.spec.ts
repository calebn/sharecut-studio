import { devices, expect, test } from "@playwright/test";
import { openHostProject } from "../e2e/overlayReachability";
import {
  createRecordRoom,
  markSharecutE2e,
  openRecordLink,
} from "../e2e/recordRoom";
import { withShareableProject } from "../e2e/shareableProject";
import {
  stubSyntheticMicrophone,
  syntheticMicrophoneRequested,
} from "../e2e/syntheticMicrophone";
import { withBrowserPages } from "../e2e/twoBrowserPages";

// `defaultBrowserType` would force a new worker per describe; each project
// already pins its engine, so borrow only the phone viewport/touch traits.
const { defaultBrowserType: _phoneEngine, ...phone } = devices["iPhone 13"];

/** Subpixel rounding can place a right/bottom edge a fraction past the viewport. */
const SUBPIXEL_TOLERANCE = 1;

test.describe("browser compatibility matrix", () => {
  test("renders the playback control across browser engines", async ({
    page,
  }) => {
    await openHostProject(page);
    await expect(page.getByRole("button", { name: "Play" })).toBeEnabled();
  });

  test.describe("phone", () => {
    test.use(phone);

    test("keeps the listening shell usable on a touch phone", async ({
      page,
    }) => {
      await openHostProject(page);

      await expect(page.locator(".daw-shell--phone")).toBeVisible();
      await expect(page.getByRole("button", { name: "Listen" })).toBeVisible();
      await expect(page.locator(".listen-hero")).toBeVisible();
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "More" })
        .click();
      const menu = page.getByRole("button", { name: "Menu", exact: true });
      await expect(menu).toBeVisible();
      const viewport = page.viewportSize();
      expect(viewport).toBeTruthy();
      const box = await menu.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        viewport!.width + SUBPIXEL_TOLERANCE,
      );
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        viewport!.height + SUBPIXEL_TOLERANCE,
      );
    });
  });

  test("takes a recording guest from microphone consent to a live level", async ({
    browser,
    browserName,
  }) => {
    await withShareableProject(async (projectPath) => {
      await withBrowserPages(browser, [{}, {}], async ([host, guest]) => {
        await host.goto(`/?project=${encodeURIComponent(projectPath)}&e2e=1`);
        await expect(host.getByRole("heading", { level: 1 })).toBeVisible();
        const room = await createRecordRoom(host, projectPath);

        await markSharecutE2e(guest);
        // Safari lacks permissions.query({ name: "microphone" }); keep the
        // native Permissions API elsewhere so each engine takes its own branch.
        await stubSyntheticMicrophone(guest, {
          removePermissionsApi: browserName === "webkit",
        });
        await openRecordLink(guest, room.guest.token);
        await expect(
          guest.getByRole("heading", { name: "Join the recording" }),
        ).toBeVisible();
        expect(
          await guest.evaluate(
            () =>
              typeof (
                navigator as Navigator & {
                  permissions?: { query?: unknown };
                }
              ).permissions?.query === "function",
          ),
        ).toBe(browserName !== "webkit");
        await guest.getByLabel("Display name").fill("Ava");
        await guest.getByLabel("I am wearing headphones").check();
        await expect(
          guest.getByRole("heading", {
            name: "Record 3 seconds of room tone",
          }),
        ).toBeVisible();
        const allow = guest.getByRole("button", { name: "Allow microphone" });
        await expect(allow).toBeVisible();
        await allow.click();
        await expect.poll(() => syntheticMicrophoneRequested(guest)).toBe(true);
        const level = guest.getByLabel("Level");
        await expect(level).toBeVisible();
        await expect
          .poll(() => level.evaluate((el) => (el as HTMLMeterElement).value))
          .toBeGreaterThan(0);
      });
    });
  });
});
