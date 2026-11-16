import { expect, type Page, type Route, test } from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { fontsReady } from "./fontsReady";
import { failBootstrap, press, SIZES, withGuestLink } from "./guestLink";
import { guestSavedCopy } from "./offlineQueue";
import { openGuestShare } from "./shareNavigation";
import { setTheme } from "./theme";

const OFFLINE_TITLE = "You're offline";
const OFFLINE_SENTENCE =
  "This page opens the episode by itself when your connection is back.";
const ASLEEP_TITLE = "The host's computer is asleep";

type Seen = { asleep: boolean; offline: boolean };

/** Notes, from before the page's own scripts run, any moment its text names the host asleep or the device offline. */
async function watchWords(page: Page) {
  await page.addInitScript(() => {
    const seen = { asleep: false, offline: false };
    (window as unknown as { __seen: Seen }).__seen = seen;
    const look = () => {
      const text = document.body?.textContent ?? "";
      seen.asleep ||= text.includes("asleep");
      seen.offline ||= /offline/i.test(text);
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
}

const wordsSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: Seen }).__seen);

/** The browser's `online` event never reaches the page: a browser that sends none. */
async function swallowOnlineEvent(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener(
      "online",
      (e) => e.stopImmediatePropagation(),
      true,
    );
  });
}

type Answer = "offline" | "refused" | "through";

/**
 * Holds the episode request the page makes on load, so the device can lose its
 * connection while that request is out. Every later request is answered the
 * way `answer` says.
 */
async function holdFirstRequest(page: Page, token: string) {
  let answer: Answer = "offline";
  let asked = 0;
  let release: (route: Route) => void = () => {};
  const first = new Promise<Route>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/review/${token}/project`, async (route) => {
    asked += 1;
    if (asked === 1) return release(route);
    if (answer === "through") return route.continue();
    return route.abort(
      answer === "offline" ? "internetdisconnected" : "connectionrefused",
    );
  });
  return {
    first,
    asked: () => asked,
    answerWith: (next: Answer) => {
      answer = next;
    },
  };
}

const deviceOnLine = (page: Page) => page.evaluate(() => navigator.onLine);

/** Loads the link, loses the connection while the episode request is out, and lets that request fail. */
async function loseConnectionOnLoad(page: Page, token: string) {
  const held = await holdFirstRequest(page, token);
  await page.goto(`/r/${token}`);
  const route = await held.first;
  await page.context().setOffline(true);
  await expect.poll(() => deviceOnLine(page)).toBe(false);
  await route.abort("internetdisconnected");
  return held;
}

/**
 * The page's clock stops, so a retry the page makes before anyone moves it
 * cannot be its 30 second timer. The studio itself needs time to run, so a test
 * resumes the clock once it has seen that request go out.
 */
async function freezeTime(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 5_000);
}

const activeElement = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    return active ? `${active.tagName}:${active.textContent}` : "none";
  });

for (const size of SIZES) {
  test.describe(`a guest whose own device has no connection at ${size.width}x${size.height}`, () => {
    test("is told so in the cover's words, with focus on the title, and never that the host is asleep", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await watchWords(guest);
        await loseConnectionOnLoad(guest, token);
        const main = guest.getByRole("main");
        await expect(
          main.getByRole("heading", { level: 1, name: OFFLINE_TITLE }),
        ).toBeVisible();
        await expect(main.getByText(OFFLINE_SENTENCE)).toBeVisible();
        await expect(
          main.getByRole("button", { name: "Try now" }),
        ).toBeVisible();
        await expect
          .poll(() => activeElement(guest))
          .toBe(`H1:${OFFLINE_TITLE}`);
        expect(await deviceOnLine(guest)).toBe(false);
        expect((await wordsSeen(guest)).asleep).toBe(false);
      });
    });

    test("opens the episode by itself when the browser reports the connection back, with no press and the clock standing still", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await watchWords(guest);
        await freezeTime(guest);
        const held = await loseConnectionOnLoad(guest, token);
        await expect(
          guest.getByRole("heading", { name: OFFLINE_TITLE }),
        ).toBeVisible();
        const before = held.asked();
        held.answerWith("through");
        await guest.context().setOffline(false);
        await expect.poll(() => held.asked()).toBe(before + 1);
        await guest.clock.resume();
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
        expect((await wordsSeen(guest)).asleep).toBe(false);
      });
    });

    test("says the host is asleep, and no longer that the device is offline, when the connection is back and the host is down", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await freezeTime(guest);
        const held = await loseConnectionOnLoad(guest, token);
        await expect(
          guest.getByRole("main").getByRole("heading"),
        ).toBeVisible();
        held.answerWith("refused");
        await guest.context().setOffline(false);
        await expect(
          guest.getByRole("heading", { name: ASLEEP_TITLE }),
        ).toBeVisible();
        await expect(guest.getByRole("main")).not.toContainText(/offline/i);
      });
    });

    test("keeps the asleep cover for a device that is online and cannot reach the host", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await watchWords(guest);
        await failBootstrap(guest, token, "abort");
        await guest.goto(`/r/${token}`);
        const main = guest.getByRole("main");
        await expect(
          main.getByRole("heading", { name: ASLEEP_TITLE }),
        ).toBeVisible();
        expect(await deviceOnLine(guest)).toBe(true);
        await press(main.getByRole("button", { name: "Try now" }), size.touch);
        await expect(main.getByRole("status")).toHaveText("Still asleep.");
        expect((await wordsSeen(guest)).offline).toBe(false);
      });
    });

    test("opens the saved copy instead of a cover when the connection is lost on load", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await watchWords(guest);
        await openGuestShare(guest, token);
        await expect.poll(() => guestSavedCopy(guest, token)).not.toBeNull();
        await loseConnectionOnLoad(guest, token);
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
        await expect(guest.getByText("Saved copy").first()).toBeVisible();
        await expect(guest.locator("main h1")).toHaveCount(0);
        expect((await wordsSeen(guest)).offline).toBe(false);
      });
    });

    test("opens by itself after 30 seconds when the browser never sends the online event", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await swallowOnlineEvent(guest);
        await freezeTime(guest);
        const held = await loseConnectionOnLoad(guest, token);
        await expect(
          guest.getByRole("main").getByRole("heading"),
        ).toBeVisible();
        const before = held.asked();
        held.answerWith("through");
        await guest.context().setOffline(false);
        await expect.poll(() => deviceOnLine(guest)).toBe(true);
        expect(held.asked()).toBe(before);
        await guest.clock.runFor(30_500);
        await expect.poll(() => held.asked()).toBe(before + 1);
        await guest.clock.resume();
        await expect(guest.locator(".stage-frame--guest")).toBeVisible();
      });
    });

    test("answers a press on Try now with Still offline. on the same button", async ({
      browser,
    }) => {
      await withGuestLink(browser, size, async (guest, token) => {
        await loseConnectionOnLoad(guest, token);
        const main = guest.getByRole("main");
        const button = main.getByRole("button", { name: "Try now" });
        await expect(button).toBeVisible();
        await fontsReady(guest);
        const rest = await button.boundingBox();
        await button.evaluate((el) => {
          el.setAttribute("data-probe", "same-button");
        });

        await press(button, size.touch);

        const probe = main.locator("[data-probe=same-button]");
        await expect(probe).toHaveAttribute("aria-busy", "true", {
          timeout: 100,
        });
        await expect(main.getByRole("status")).toHaveText("Still offline.");
        await expect(main.getByRole("heading")).toHaveText(OFFLINE_TITLE);
        await expect(probe).toBeVisible();
        expect(await probe.boundingBox()).toEqual(rest);
        await expect
          .poll(() =>
            guest.evaluate(
              () =>
                document.activeElement?.getAttribute("data-probe") ?? "none",
            ),
          )
          .toBe("same-button");
      });
    });

    if (!size.touch) {
      test("never leaves one word alone on the sentence's last line", async ({
        browser,
      }) => {
        await withGuestLink(browser, size, async (guest, token) => {
          await loseConnectionOnLoad(guest, token);
          const sentence = guest.getByRole("main").locator(".sys-cover-text");
          await expect(sentence).toHaveText(OFFLINE_SENTENCE);
          await fontsReady(guest);
          const lastLine = await sentence.evaluate((el) => {
            const text = el.firstChild as Text;
            const words = [...text.data.matchAll(/\S+/g)];
            const top = (word: RegExpMatchArray) => {
              const range = document.createRange();
              range.setStart(text, word.index ?? 0);
              range.setEnd(text, (word.index ?? 0) + word[0].length);
              return range.getBoundingClientRect().top;
            };
            const lastTop = top(words[words.length - 1]!);
            return words.filter((word) => top(word) === lastTop).length;
          });
          expect(lastLine).toBeGreaterThan(1);
        });
      });
    }

    for (const colorScheme of ["light", "dark"] as const) {
      test(`passes axe in the ${colorScheme} theme`, async ({ browser }) => {
        await withGuestLink(browser, size, async (guest, token) => {
          await loseConnectionOnLoad(guest, token);
          await expect(
            guest.getByRole("heading", { name: OFFLINE_TITLE }),
          ).toBeVisible();
          await setTheme(guest, colorScheme);
          await fontsReady(guest);
          await expectReadingSurfaceAxeClean(guest);
        });
      });
    }
  });
}
