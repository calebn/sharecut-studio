import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import {
  ensureHostRecordCommand,
  joinAsGuest,
  openHostDevices,
  openHostMore,
  openRecordLink,
  roomTile,
} from "./recordRoom";
import { inRoom, LAPTOP, phoneAt } from "./recordRoomPages";
import { setTheme } from "./theme";

/**
 * #4660: the phone Comments sheet rests on the Room dock instead of covering
 * it. Every edge is read from laid-out rects, never a pixel constant.
 */

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

const BOTTOM = "--room-sheet-bottom";
const END = "--room-sheet-end";
const DETENTS = ["peek", "half", "full"] as const;
type Detent = (typeof DETENTS)[number];

const dock = (page: Page) => page.locator(".sys-room-view-dock");
const panel = (page: Page) => page.getByRole("dialog", { name: /^Comments/ });
const peek = (page: Page) => page.locator(".sys-room-view-peek");
const dockButtons = (page: Page) =>
  page.getByRole("group", { name: "Recording controls" }).getByRole("button");

async function setDetent(page: Page, detent: Detent) {
  await panel(page)
    .locator(".bottom-sheet-detent")
    .fill(String(DETENTS.indexOf(detent)));
  await expect(panel(page)).toHaveClass(new RegExp(`bottom-sheet--${detent}`));
}

async function settledBottom(locator: Locator) {
  let last = Number.NaN;
  await expect
    .poll(async () => {
      const now = (await rectOf(locator)).bottom;
      const settled = now === last;
      last = now;
      return settled;
    })
    .toBe(true);
  return last;
}

async function rectOf(locator: Locator) {
  return locator.evaluate((el) => {
    const { top, bottom, left, right } = el.getBoundingClientRect();
    return { top, bottom, left, right };
  });
}

async function dockMisses(page: Page) {
  return dockButtons(page).evaluateAll((buttons) =>
    buttons.flatMap((button) => {
      const { left, right, top, bottom } = button.getBoundingClientRect();
      const x = (left + right) / 2;
      return [top + 2, (top + bottom) / 2, bottom - 2]
        .filter(
          (y) => document.elementFromPoint(x, y)?.closest("button") !== button,
        )
        .map(
          (y) =>
            `${button.getAttribute("aria-label") ?? button.textContent} at y=${y}`,
        );
    }),
  );
}

async function expectDockReachable(page: Page) {
  expect(await dockMisses(page), "dock buttons hit-test to themselves").toEqual(
    [],
  );
}

async function expectRestsOnDock(page: Page) {
  await expect
    .poll(async () => {
      const [p, d] = [await rectOf(panel(page)), await rectOf(dock(page))];
      return Math.abs(p.bottom - d.top);
    })
    .toBeLessThanOrEqual(1);
}

async function expectNoRoomSheetState(page: Page) {
  expect(
    await page.evaluate(
      ([bottom, end]) => ({
        bottom: document.documentElement.style.getPropertyValue(bottom!),
        end: document.documentElement.style.getPropertyValue(end!),
        mode: document.documentElement.getAttribute("data-room-sheet"),
      }),
      [BOTTOM, END],
    ),
  ).toEqual({ bottom: "", end: "", mode: null });
}

const HOST_VIEWPORTS = [
  [390, 844],
  [375, 667],
  [667, 375],
  [320, 568],
] as const;

test.describe("host phone", () => {
  for (const [width, height] of HOST_VIEWPORTS) {
    test(`${width}x${height}: the sheet rests on the dock at every detent and the dock stays tappable`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      test.slow();
      await inRoom(
        browser,
        { host: phoneAt(width, height), guest: LAPTOP },
        async ({ host, guest, projectPath, room }) => {
          await joinAsGuest(guest, room.guest.token, "Ava");
          await ensureHostRecordCommand(
            host,
            projectPath,
            "Start",
            "recording",
          );
          // A live take starts collapsed to the peek bar; one tap opens it.
          await expect(peek(host)).toHaveAttribute("aria-expanded", "false");
          await expect(panel(host)).toHaveCount(0);
          await expectNoRoomSheetState(host);
          await peek(host).tap();
          await expect(panel(host)).toBeVisible();
          await expect(panel(host)).toHaveClass(/sys-room-comments/);
          await expect(dock(host)).toBeVisible();

          await expectRestsOnDock(host);
          await expectDockReachable(host);
          for (const detent of [...DETENTS, "half"] as const) {
            await setDetent(host, detent);
            await expectRestsOnDock(host);
            await expectDockReachable(host);
          }

          const covered = await peek(host).evaluate(
            (el) =>
              document
                .elementFromPoint(
                  el.getBoundingClientRect().left +
                    el.getBoundingClientRect().width / 2,
                  el.getBoundingClientRect().top +
                    el.getBoundingClientRect().height / 2,
                )
                ?.closest(".sys-room-view-peek") !== el,
          );
          expect(
            covered,
            "the peek bar is covered while the sheet is open",
          ).toBe(true);

          await host
            .getByRole("button", { name: "Pause take", exact: true })
            .tap();
          await expect(panel(host)).toBeVisible();
          await host.getByRole("button", { name: /^Mute/ }).tap();
          await expect(panel(host)).toBeVisible();
          await expectRestsOnDock(host);

          await panel(host).getByRole("button", { name: "Close" }).tap();
          await expect(panel(host)).toHaveCount(0);
          await expect(peek(host)).toBeVisible();
          await peek(host).tap();
          await expect(panel(host)).toBeVisible();
          await expectNoHorizontalScroll(host);
        },
      );
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`390x844 ${theme}: axe clean with the sheet open`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      test.slow();
      await inRoom(
        browser,
        { host: phoneAt(390), guest: LAPTOP },
        async ({ host }) => {
          await setTheme(host, theme);
          await expect(panel(host)).toBeVisible();
          await expectRestsOnDock(host);
          await expectReadingSurfaceAxeClean(host);
        },
      );
    });
  }

  test("390x844 at 200% text: the sheet still rests on the dock", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async ({ host }) => {
        await host.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
        await expect(panel(host)).toBeVisible();
        await expectRestsOnDock(host);
        await expectNoHorizontalScroll(host);
        const open = await dockMisses(host);
        await panel(host).getByRole("button", { name: "Close" }).tap();
        await expect(panel(host)).toHaveCount(0);
        // More misses two of three points at 200% with the sheet closed too, so
        // that is not the sheet; the sheet must add no miss of its own.
        const closed = await dockMisses(host);
        expect(
          open.filter((miss) => !closed.includes(miss)),
          "the open sheet adds no dock miss",
        ).toEqual([]);
      },
    );
  });

  test("a feedback toast stays above the dock at closed, half and full", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async ({ host, guest, room }) => {
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(panel(host)).toBeVisible();
        const more = await openHostMore(host);
        await more.getByRole("button", { name: "Room tone" }).tap();
        const toast = host.locator(".ui-toast-region--app .ui-toast");
        await expect(toast).toBeVisible();
        const clearOfDock = () =>
          expect
            .poll(async () => {
              const [t, d] = [await rectOf(toast), await rectOf(dock(host))];
              return d.top - t.bottom;
            })
            .toBeGreaterThanOrEqual(0);
        for (const detent of ["half", "full"] as const) {
          await setDetent(host, detent);
          await clearOfDock();
        }
        await panel(host).getByRole("button", { name: "Close" }).tap();
        await expect(panel(host)).toHaveCount(0);
        await clearOfDock();
      },
    );
  });

  test("the End session toast stays above the dock at closed, half and full", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async ({ host, guest, room }) => {
        await joinAsGuest(guest, room.guest.token, "Ava");
        await expect(panel(host)).toBeVisible();
        const more = await openHostMore(host);
        await more.getByRole("button", { name: "End session" }).tap();
        const toast = host.locator(".sys-toast-dock .ui-toast");
        await expect(toast).toBeVisible();
        const clearOfDock = () =>
          expect
            .poll(async () => {
              const [t, d] = [await rectOf(toast), await rectOf(dock(host))];
              return d.top - t.bottom;
            })
            .toBeGreaterThanOrEqual(0);
        for (const detent of ["half", "full"] as const) {
          await setDetent(host, detent);
          await clearOfDock();
        }
        await panel(host).getByRole("button", { name: "Close" }).tap();
        await expect(panel(host)).toHaveCount(0);
        await clearOfDock();
      },
    );
  });

  test("a Devices sheet opened over Comments keeps its own rest", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async ({ host }) => {
        const devices = host.getByRole("dialog", {
          name: "Devices",
          exact: true,
        });
        await panel(host).getByRole("button", { name: "Close" }).tap();
        await expect(panel(host)).toHaveCount(0);
        await openHostDevices(host);
        const alone = await settledBottom(devices);
        await devices.getByRole("button", { name: "Close" }).tap();
        await expect(devices).toHaveCount(0);

        await peek(host).tap();
        await expect(panel(host)).toBeVisible();
        await openHostDevices(host);
        await expect(devices).toBeVisible();
        expect(await settledBottom(devices)).toBeCloseTo(alone, 0);
        await expectRestsOnDock(host);
        const restOf = (sheet: Locator) =>
          sheet.evaluate(
            (el) => getComputedStyle(el.parentElement as HTMLElement).bottom,
          );
        expect(await restOf(devices)).not.toBe(await restOf(panel(host)));
      },
    );
  });

  test("with the keyboard up the sheet follows the keyboard, not the dock", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: phoneAt(390), guest: LAPTOP },
      async ({ host }) => {
        await expect(panel(host)).toBeVisible();
        await expectRestsOnDock(host);
        await simulateKeyboard(host, 271);
        const root = panel(host).locator("xpath=..");
        await expect
          .poll(() => root.evaluate((el) => getComputedStyle(el).bottom))
          .toBe("271px");
        const composer = await rectOf(panel(host).locator(".sys-notes-input"));
        const viewport = await host.evaluate(() => innerHeight);
        expect(composer.bottom).toBeLessThanOrEqual(viewport - 271 + 1);
        await clearKeyboard(host);
        await expectRestsOnDock(host);
      },
    );
  });

  test("the detent sizes are the ones the sheet has without the dock rest", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    for (const [width, height] of [
      [390, 844],
      [667, 375],
    ] as const) {
      await inRoom(
        browser,
        { host: phoneAt(width, height), guest: LAPTOP },
        async ({ host }) => {
          await expect(panel(host)).toBeVisible();
          for (const detent of DETENTS) {
            await setDetent(host, detent);
            await expectRestsOnDock(host);
            const { withRest, without, panelHeight, rootHeight, rem, sizing } =
              await host.evaluate(() => {
                const sheet = document.querySelector<HTMLElement>(
                  ".bottom-sheet",
                ) as HTMLElement;
                const read = () => {
                  const s = getComputedStyle(sheet);
                  return [s.maxBlockSize, s.minBlockSize];
                };
                const html = document.documentElement;
                const withRest = read();
                const mode = html.getAttribute("data-room-sheet");
                html.removeAttribute("data-room-sheet");
                const without = read();
                if (mode) html.setAttribute("data-room-sheet", mode);
                // The rest rules move the root only: none may size the panel.
                const sizing: string[] = [];
                const walk = (rules: CSSRuleList) => {
                  for (const rule of Array.from(rules)) {
                    if (rule instanceof CSSStyleRule) {
                      const { style } = rule;
                      if (
                        rule.selectorText.includes("data-room-sheet") &&
                        (style.height ||
                          style.blockSize ||
                          style.minBlockSize ||
                          style.maxBlockSize ||
                          style.minHeight ||
                          style.maxHeight)
                      )
                        sizing.push(rule.selectorText);
                    } else if ("cssRules" in rule) {
                      walk((rule as CSSGroupingRule).cssRules);
                    }
                  }
                };
                for (const sheetRules of Array.from(document.styleSheets)) {
                  try {
                    walk(sheetRules.cssRules);
                  } catch {
                    // cross-origin sheet: nothing of ours
                  }
                }
                return {
                  withRest,
                  without,
                  sizing,
                  panelHeight: sheet.getBoundingClientRect().height,
                  rootHeight: (
                    sheet.parentElement as HTMLElement
                  ).getBoundingClientRect().height,
                  rem: Number.parseFloat(getComputedStyle(html).fontSize),
                };
              });
            expect(
              withRest,
              `${detent}: max and min block size are declared the same with and without the rest`,
            ).toEqual(without);
            expect(sizing, "no dock-rest rule sizes the panel").toEqual([]);
            if (detent === "peek")
              expect(panelHeight).toBeLessThanOrEqual(7.5 * rem + 1);
            if (detent === "half") {
              // Half is 50% of the slot; on a short screen the sheet's own floor
              // (bottom-sheet.css, max-height 40rem) is 9rem or the whole slot.
              const floor = Math.min(rootHeight, 9 * rem);
              expect(panelHeight).toBeLessThanOrEqual(
                Math.max(rootHeight * 0.5, floor) + 1,
              );
              expect(panelHeight).toBeLessThanOrEqual(
                Math.max(26.25 * rem, floor) + 1,
              );
            }
            if (detent === "full")
              expect(panelHeight).toBeLessThanOrEqual(rootHeight + 1);
          }
        },
      );
    }
  });
});

test.describe("guest phone", () => {
  test("390x844: the sheet rests on the dock at every detent and the dock stays tappable", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { guest: phoneAt(390) },
      async ({ host, guest, projectPath, room }) => {
        await joinAsGuest(guest, room.guest.token, "Ava");
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expect(roomTile(guest, "Ava")).toBeVisible();
        await peek(guest).tap();
        await expect(panel(guest)).toBeVisible();
        for (const detent of [...DETENTS, "half"] as const) {
          await setDetent(guest, detent);
          await expectRestsOnDock(guest);
          await expectDockReachable(guest);
        }
        await guest.getByRole("button", { name: /^Mute/ }).tap();
        await expect(panel(guest)).toBeVisible();
        await panel(guest).getByRole("button", { name: "Close" }).tap();
        await expect(panel(guest)).toHaveCount(0);
        await expectNoRoomSheetState(guest);
        await expect(peek(guest)).toBeVisible();
      },
    );
  });

  test("667x375: the panel ends where the dock column begins, and rotating leaves no stale token", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { guest: phoneAt(667, 375) },
      async ({ host, guest, projectPath, room }) => {
        await joinAsGuest(guest, room.guest.token, "Ava");
        await ensureHostRecordCommand(host, projectPath, "Start", "recording");
        await expect(guest.locator(".sys-room-view")).toHaveAttribute(
          "data-width",
          "phone-landscape",
        );
        await guest.getByRole("button", { name: /^Comments/ }).tap();
        await expect(panel(guest)).toBeVisible();
        await expectDockReachable(guest);
        await expect
          .poll(async () => {
            const [p, d] = [
              await rectOf(panel(guest)),
              await rectOf(dock(guest)),
            ];
            return Math.abs(p.right - d.left);
          })
          .toBeLessThanOrEqual(1);
        const tokens = () =>
          guest.evaluate(
            ([bottom, end]) => ({
              bottom: document.documentElement.style.getPropertyValue(bottom!),
              end: document.documentElement.style.getPropertyValue(end!),
            }),
            [BOTTOM, END],
          );
        expect((await tokens()).bottom).toBe("");
        expect((await tokens()).end).not.toBe("");

        await guest.setViewportSize({ width: 390, height: 844 });
        await expect.poll(async () => (await tokens()).end).toBe("");
        expect((await tokens()).bottom).not.toBe("");
        await expectRestsOnDock(guest);

        await guest.setViewportSize({ width: 667, height: 375 });
        await expect.poll(async () => (await tokens()).bottom).toBe("");
        expect((await tokens()).end).not.toBe("");
      },
    );
  });

  test("a guest who said Not now has no sheet and no token", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(browser, { guest: phoneAt(390) }, async ({ guest, room }) => {
      await openRecordLink(guest, room.guest.token);
      await guest.getByRole("button", { name: "Allow microphone" }).click();
      await guest
        .getByRole("dialog")
        .getByRole("button", { name: "Not now" })
        .click();
      await expect(guest.getByRole("dialog")).toHaveCount(0);
      await expect(panel(guest)).toHaveCount(0);
      await expectNoRoomSheetState(guest);
    });
  });
});

test("1280x800: the laptop publishes no room-sheet state and keeps the Comments rail", async ({
  browser,
}: {
  browser: Browser;
}) => {
  test.slow();
  await inRoom(browser, { host: LAPTOP, guest: LAPTOP }, async ({ host }) => {
    const boxes = async () => ({
      rail: await rectOf(host.locator(".sys-room-view-rail")),
      dock: await rectOf(dock(host)),
    });
    await expect(host.locator(".sys-room-view-rail")).toBeVisible();
    await expect(panel(host)).toHaveCount(0);
    await expectNoRoomSheetState(host);
    const before = await boxes();
    await host.setViewportSize({ width: 1281, height: 800 });
    await host.setViewportSize({ width: 1280, height: 800 });
    await expectNoRoomSheetState(host);
    expect(await boxes()).toEqual(before);
  });
});

async function simulateKeyboard(page: Page, inset: number) {
  await page.evaluate((px) => {
    const root = document.documentElement;
    root.dataset.keyboard = "open";
    root.style.setProperty("--visual-viewport-top", "0px");
    root.style.setProperty("--keyboard-inset", `${px}px`);
  }, inset);
}

async function clearKeyboard(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    delete root.dataset.keyboard;
    root.style.removeProperty("--visual-viewport-top");
    root.style.removeProperty("--keyboard-inset");
  });
}

async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
