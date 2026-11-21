import { expect, type Page, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { deviceOnLine, NARROW_PHONE, SIZES, withGuestLink } from "./guestLink";
import { guestSavedCopy } from "./offlineQueue";
import { openGuestShare } from "./shareNavigation";
import { setTheme } from "./theme";

/**
 * A guest's page that is already open stops reaching the host, or the guest's
 * own device goes offline: the light says so within seconds, says it once, and
 * goes quiet again when the host answers. A page that opened on the saved copy
 * becomes the live episode by itself.
 */

const HOST_AWAY = "Can't reach the host";
const HOST_SENTENCE = "Can't reach the host. This page keeps trying.";
const DEVICE_AWAY = "You're offline";
const DEVICE_SENTENCE = "You're offline. This page keeps trying.";

const LIGHT_WITHIN_MS = 10_000;
const AWAY_TEST_TIMEOUT_MS = 180_000;

const light = (page: Page) => page.locator(".sys-save").first();

async function hostGoesAway(page: Page, token: string) {
  const refused = { first: 0, count: 0 };
  const handler = async (route: import("@playwright/test").Route) => {
    refused.first ||= Date.now();
    refused.count += 1;
    await route.abort("connectionrefused");
  };
  await page.route(`**/api/review/${token}/**`, handler);
  return {
    refused,
    back: () => page.unroute(`**/api/review/${token}/**`, handler),
  };
}

async function watchLiveRegions(page: Page) {
  await page.evaluate(() => {
    const heard: string[] = [];
    (window as unknown as { __heard: string[] }).__heard = heard;
    const last = new WeakMap<Element, string>();
    const look = () => {
      for (const node of document.querySelectorAll(
        '[role="status"], [role="alert"], [aria-live]',
      )) {
        const text = node.textContent?.trim() ?? "";
        if (last.get(node) === text) continue;
        last.set(node, text);
        if (text) heard.push(text);
      }
    };
    look();
    heard.length = 0;
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

const heard = (page: Page) =>
  page.evaluate(() => (window as unknown as { __heard: string[] }).__heard);

test.describe.configure({ timeout: AWAY_TEST_TIMEOUT_MS });

for (const size of SIZES) {
  test.describe(`a page that loses its host while open at ${size.width}x${size.height}`, () => {
    test("says it within seconds of the failed requests, says it once, and returns to Saved when the host answers", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await openGuestShare(guest, token);
        await expect(light(guest)).toHaveText("Saved");
        await guest.evaluate(() => {
          (window as unknown as { __page: number }).__page = 1;
        });

        const away = await hostGoesAway(guest, token);
        await expect
          .poll(() => away.refused.first, { timeout: 45_000 })
          .toBeGreaterThan(0);
        await expect(light(guest)).toContainText(HOST_SENTENCE, {
          timeout: LIGHT_WITHIN_MS,
        });
        expect(Date.now() - away.refused.first).toBeLessThan(LIGHT_WITHIN_MS);
        await expect(light(guest)).toHaveAttribute("title", HOST_SENTENCE);
        await expect(
          guest.getByRole("status").filter({ hasText: HOST_AWAY }),
        ).toHaveCount(1);

        await watchLiveRegions(guest);
        const asked = away.refused.count;
        await expect
          .poll(() => away.refused.count - asked, { timeout: 45_000 })
          .toBeGreaterThanOrEqual(3);
        expect(
          (await heard(guest)).filter((text) => /^Saving$|^Saved$/.test(text)),
        ).toEqual([]);
        await expect(light(guest)).toContainText(HOST_SENTENCE);

        await away.back();
        await expect(light(guest)).toHaveText("Saved", { timeout: 15_000 });
        expect(
          await guest.evaluate(
            () => (window as unknown as { __page?: number }).__page,
          ),
        ).toBe(1);
        const spoken = await heard(guest);
        expect(spoken[0]).toBe("Saved");
      });
    });
  });

  test.describe(`a page whose device goes offline while open at ${size.width}x${size.height}`, () => {
    test("says the device is offline within seconds and returns to Saved when it is back", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await openGuestShare(guest, token);
        await expect(light(guest)).toHaveText("Saved");

        await guest.context().setOffline(true);
        await expect.poll(() => deviceOnLine(guest)).toBe(false);
        await expect(light(guest)).toContainText(DEVICE_SENTENCE, {
          timeout: LIGHT_WITHIN_MS,
        });
        await expect(light(guest)).toHaveAttribute("title", DEVICE_SENTENCE);
        expect(DEVICE_AWAY).toBe("You're offline");

        await guest.context().setOffline(false);
        await expect(light(guest)).toHaveText("Saved", { timeout: 15_000 });
      });
    });
  });
}

for (const viewport of [SIZES[0], NARROW_PHONE]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`passes axe while away at ${viewport.width}px in the ${colorScheme} theme`, async ({
      browser,
    }) => {
      await withGuestLink(browser, viewport, async (guest, token) => {
        await openGuestShare(guest, token);
        await guest.context().setOffline(true);
        await expect(light(guest)).toContainText(DEVICE_SENTENCE, {
          timeout: LIGHT_WITHIN_MS,
        });
        await setTheme(guest, colorScheme);
        await expectReadingSurfaceAxeClean(guest);
      });
    });
  }
}

test.describe("a page that opened on the saved copy", () => {
  test("becomes the live episode by itself when the host answers, without a reload", async ({
    browser,
  }) => {
    const size = SIZES[1];
    await withGuestLink(browser, size, async (guest, token) => {
      await openGuestShare(guest, token);
      await expect.poll(() => guestSavedCopy(guest, token)).not.toBeNull();

      const away = await hostGoesAway(guest, token);
      await guest.reload();
      await expect(
        guest.getByRole("heading", { name: "The host's computer is asleep" }),
      ).toBeVisible();
      await expect(light(guest)).toContainText("Saved copy");
      await guest.evaluate(() => {
        (window as unknown as { __page: number }).__page = 1;
      });

      await away.back();
      await expect(
        guest.getByRole("heading", { name: "The host's computer is asleep" }),
      ).toHaveCount(0, { timeout: 45_000 });
      await expect(light(guest)).toHaveText("Saved", { timeout: 15_000 });
      await expect(
        guest.getByRole("button", { name: /Explain .* role/ }),
      ).toBeVisible({ timeout: 15_000 });
      expect(
        await guest.evaluate(
          () => (window as unknown as { __page?: number }).__page,
        ),
      ).toBe(1);
    });
  });
});
