import fs from "node:fs";
import {
  type Browser,
  type BrowserContextOptions,
  expect,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";
import { expectReadingSurfaceAxeClean } from "./axe";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { LIVE_PILL } from "./recordLiveTake";
import {
  ensureHostRecordCommand,
  hostRecordState,
  joinAsGuest,
  roomPill,
  stopHostTake,
} from "./recordRoom";
import { inRoom, LAPTOP, phoneAt } from "./recordRoomPages";
import { setTheme, withAppearance } from "./theme";

/**
 * #4660 item 5a: the live Stop button's "Hold to stop" caption.
 *
 * The main block is 5 tests, one per cell. `withAppearance` gives each cell a
 * single theme and motion pairing, not the full cross. Each test runs rest,
 * tap, expiry, second tap and busy in one body because `inRoom` is costly to
 * repeat.
 *
 * The sr-only description of the button contains "Enter or Space", so a text
 * query on it matches that span too. The caption is therefore found with
 * `.sys-record-hint` and the description by accessible description (it does
 * not contain "Hold to stop").
 */

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

const NBSP = " ";

type Cell = {
  name: string;
  options: BrowserContextOptions;
  touch: boolean;
  /** Take the rest and nudge screenshots (A8c, read by a person). */
  shots: boolean;
};

const CELLS: Cell[] = [
  { name: "laptop 1280", options: LAPTOP, touch: false, shots: true },
  { name: "iPhone 390", options: phoneAt(390), touch: true, shots: true },
  { name: "phone 360", options: phoneAt(360), touch: true, shots: true },
  { name: "phone 320", options: phoneAt(320), touch: true, shots: true },
  {
    name: "landscape 667x375",
    options: phoneAt(667, 375),
    touch: true,
    shots: false,
  },
];

const stopButton = (page: Page) =>
  page.locator(".sys-record").getByRole("button", { name: "Stop take" });
const caption = (page: Page) => page.locator(".sys-record-hint");
const status = (page: Page) => page.locator(".sys-record [role=status]");
const dock = (page: Page) => page.locator(".sys-dock");
const pause = (page: Page) =>
  dock(page).getByRole("button", { name: "Pause take", exact: true });

async function press(page: Page, touch: boolean) {
  if (touch) {
    await stopButton(page).tap();
  } else {
    await stopButton(page).click();
  }
}

/** Resolve a colour token the way the page does, through a probe element. */
async function tokenColors(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const colors = {
      primary: read("--color-text-primary"),
      secondary: read("--color-text-secondary"),
    };
    probe.remove();
    return colors;
  });
}

async function look(page: Page) {
  return caption(page).evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      weight: style.fontWeight,
      text: el.textContent,
      nudge: el.hasAttribute("data-nudge"),
    };
  });
}

type Box = { x: number; y: number; w: number; h: number };

async function boxOf(locator: ReturnType<typeof caption>): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  const { x, y, width, height } = b as NonNullable<typeof b>;
  return { x, y, w: width, h: height };
}

/**
 * The caption's layout box, read through offset metrics. Unlike
 * getBoundingClientRect these ignore transforms and the individual translate
 * property, so the nudge-bump shake cannot move what is measured.
 */
async function layoutBoxOf(locator: ReturnType<typeof caption>): Promise<Box> {
  return locator.evaluate((el) => {
    const e = el as HTMLElement;
    return {
      x: e.offsetLeft,
      y: e.offsetTop,
      w: e.offsetWidth,
      h: e.offsetHeight,
    };
  });
}

/** The boxes that must not move when the caption appears, bolds or goes. */
async function layout(page: Page) {
  return {
    record: await boxOf(stopButton(page)),
    pause: await boxOf(pause(page)),
    hint: await layoutBoxOf(caption(page)),
    dock: await boxOf(dock(page)),
  };
}

function expectSameLayout(
  actual: Awaited<ReturnType<typeof layout>>,
  expected: Awaited<ReturnType<typeof layout>>,
  label: string,
) {
  for (const key of ["record", "pause", "hint", "dock"] as const) {
    for (const edge of ["x", "y", "w", "h"] as const) {
      expect(
        Math.abs(actual[key][edge] - expected[key][edge]),
        `${label}: ${key}.${edge} ${actual[key][edge]} vs ${expected[key][edge]}`,
      ).toBeLessThanOrEqual(0.5);
    }
  }
}

/** The glyphs' own box (the slot is a fixed 4rem wide and the text may spill). */
async function textBox(page: Page) {
  return caption(page).evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { left, right, top, bottom } = range.getBoundingClientRect();
    const dock = document.querySelector(".sys-dock") as HTMLElement;
    const d = dock.getBoundingClientRect();
    return {
      left,
      right,
      top,
      bottom,
      dock: { left: d.left, right: d.right, top: d.top, bottom: d.bottom },
      width: innerWidth,
      height: innerHeight,
    };
  });
}

async function expectCaptionWhole(page: Page) {
  const t = await textBox(page);
  expect(t.right - t.left, "the caption has glyphs").toBeGreaterThan(20);
  expect(t.left).toBeGreaterThanOrEqual(0);
  expect(t.right).toBeLessThanOrEqual(t.width);
  expect(t.top).toBeGreaterThanOrEqual(t.dock.top - 0.5);
  expect(t.bottom).toBeLessThanOrEqual(t.dock.bottom + 0.5);
  expect(t.bottom).toBeLessThanOrEqual(t.height);
}

async function attachShot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const body = await dock(page).screenshot();
  await testInfo.attach(name, { body, contentType: "image/png" });
  const dir = process.env.STOP_HINT_SHOTS;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/${name}.png`, body);
  }
}

async function goLive(
  page: Page,
  guest: Page,
  projectPath: string,
  room: { guest: { token: string } },
) {
  await joinAsGuest(guest, room.guest.token, "Ava");
  await ensureHostRecordCommand(page, projectPath, "Start", "recording");
  await expect(stopButton(page)).toBeVisible();
}

/** Hold the record command until `release()`, so the host stays busy. */
async function delayRecordCommands(page: Page) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/record/command", async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

test.describe("a live Stop button", () => {
  for (const { cell, theme, reducedMotion } of withAppearance(CELLS)) {
    test(`${cell.name} (${theme}, ${reducedMotion ? "reduced" : "full"} motion): caption at rest, tap emphasis, layout still, busy keeps the slot`, async ({
      browser,
    }: {
      browser: Browser;
    }, testInfo) => {
      test.slow();
      await inRoom(
        browser,
        {
          host: {
            ...cell.options,
            reducedMotion: reducedMotion ? "reduce" : "no-preference",
          },
          guest: LAPTOP,
        },
        async ({ host, guest, projectPath, room }) => {
          await setTheme(host, theme);
          const stops: string[] = [];
          host.on("request", (req) => {
            const data = req.postData() ?? "";
            if (req.method() === "POST" && /record\/command/.test(req.url())) {
              stops.push(data);
            }
          });
          await goLive(host, guest, projectPath, room);
          const colors = await tokenColors(host);

          await expect(caption(host)).toBeVisible();
          await expect(caption(host)).toHaveText("Hold to stop");
          await expectCaptionWhole(host);
          const rest = await look(host);
          expect(rest.color).toBe(colors.secondary);
          expect(rest.weight).not.toBe("600");
          expect(rest.nudge).toBe(false);
          await expect(status(host)).toHaveText("");
          const before = await layout(host);
          // The Record column is the 4rem disc: a caption that widened it would
          // be wider at rest too, so compare against the token, not "before".
          const column = await stopButton(host).evaluate((el) => ({
            rem: parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            ),
            parent: (el.parentElement as HTMLElement).offsetWidth,
          }));
          expect(
            before.record.w,
            "the Record button stays 4rem wide",
          ).toBeLessThanOrEqual(4 * column.rem + 0.5);
          expect(
            column.parent,
            "the Record column is no wider than its 4rem button",
          ).toBeLessThanOrEqual(4 * column.rem + 0.5);
          if (cell.shots) {
            await attachShot(host, testInfo, `rest-${cell.name}`);
          }
          const stopsBefore = stops.length;

          // The animation can be as short as a frame or two: remember its start.
          await host.evaluate(() => {
            const w = window as unknown as { __nudgeStarts: number };
            w.__nudgeStarts = 0;
            document.addEventListener("animationstart", (event) => {
              if ((event as AnimationEvent).animationName === "nudge-bump") {
                w.__nudgeStarts += 1;
              }
            });
          });
          const starts = () =>
            host.evaluate(
              () =>
                (window as unknown as { __nudgeStarts: number }).__nudgeStarts,
            );

          await press(host, cell.touch);
          await expect(status(host)).toHaveText("Hold to stop");
          const nudged = await look(host);
          expect(nudged.nudge).toBe(true);
          expect(nudged.color).toBe(colors.primary);
          expect(nudged.color).not.toBe(rest.color);
          expect(nudged.weight).toBe("600");
          expect(nudged.text).toBe("Hold to stop");
          if (reducedMotion) {
            expect(await starts()).toBe(0);
          } else {
            // Poll the start counter right after the tap, with no fixed wait.
            await expect
              .poll(async () => (await starts()) > 0, {
                intervals: [0, 10, 10, 10, 20, 20, 50],
              })
              .toBe(true);
          }
          if (cell.shots) {
            await attachShot(host, testInfo, `nudge-${cell.name}`);
          }
          await expectCaptionWhole(host);
          expectSameLayout(await layout(host), before, "during the nudge");

          await expect(caption(host)).not.toHaveAttribute("data-nudge", /./, {
            timeout: 6_000,
          });
          const after = await look(host);
          expect(after.text).toBe("Hold to stop");
          expect(after.color).toBe(colors.secondary);
          expect(after.weight).not.toBe("600");
          await expect(status(host)).toHaveText("");
          await expect(roomPill(host)).toHaveText(LIVE_PILL);
          expect(stops.length, "a tap sent no command").toBe(stopsBefore);
          expectSameLayout(await layout(host), before, "after the nudge");

          if (!reducedMotion) {
            const first = await starts();
            await press(host, cell.touch);
            await expect
              .poll(starts, { intervals: [0, 10, 20, 50] })
              .toBeGreaterThan(first);
          }

          await expect(caption(host)).not.toHaveAttribute("data-nudge", /./, {
            timeout: 6_000,
          });
          const release = await delayRecordCommands(host);
          try {
            await pause(host).click();
            await expect.poll(async () => (await look(host)).text).toBe(NBSP);
            expect((await look(host)).nudge).toBe(false);
            await expect(status(host)).toHaveText("");
            await expect(stopButton(host)).not.toHaveAttribute(
              "aria-describedby",
            );
            expectSameLayout(await layout(host), before, "while busy");
          } finally {
            release();
          }
        },
      );
    });
  }

  for (const theme of ["light", "dark"] as const) {
    test(`iPhone 390 ${theme}: axe clean at rest, during the nudge and while busy`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      test.slow();
      await inRoom(
        browser,
        { host: phoneAt(390), guest: LAPTOP },
        async ({ host, guest, projectPath, room }) => {
          await setTheme(host, theme);
          await goLive(host, guest, projectPath, room);
          await expect(caption(host)).toHaveText("Hold to stop");
          await expectReadingSurfaceAxeClean(host);

          await stopButton(host).tap();
          await expect(caption(host)).toHaveAttribute("data-nudge");
          await expectReadingSurfaceAxeClean(host);

          await expect(caption(host)).not.toHaveAttribute("data-nudge", /./, {
            timeout: 6_000,
          });
          const release = await delayRecordCommands(host);
          try {
            await pause(host).click();
            await expect.poll(async () => (await look(host)).text).toBe(NBSP);
            await expectReadingSurfaceAxeClean(host);
          } finally {
            release();
          }
        },
      );
    });
  }

  test("laptop: the button is described for keyboard users ([GUARD] a tap does not stop, a full hold does)", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: LAPTOP, guest: LAPTOP },
      async ({ host, guest, projectPath, room }) => {
        await goLive(host, guest, projectPath, room);
        await expect(stopButton(host)).toHaveAccessibleDescription(
          /Enter or Space/,
        );
        await expect(stopButton(host)).toHaveAccessibleDescription(/confirm/);
        await expect(stopButton(host)).toHaveAccessibleDescription(
          /^(?!.*Hold to stop)/,
        );
        await stopButton(host).click();
        await expect(roomPill(host)).toHaveText(LIVE_PILL);
        expect(await hostRecordState(host, projectPath)).toBe("recording");

        const box = await boxOf(stopButton(host));
        await host.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
        await host.mouse.down();
        await expect
          .poll(() => hostRecordState(host, projectPath))
          .not.toBe("recording");
        await host.mouse.up();
      },
    );
  });

  test("laptop: [GUARD] Enter asks, the confirm stops", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.slow();
    await inRoom(
      browser,
      { host: LAPTOP, guest: LAPTOP },
      async ({ host, guest, projectPath, room }) => {
        await goLive(host, guest, projectPath, room);
        await expect(stopButton(host)).toHaveAccessibleName("Stop take");
        await stopHostTake(host, host.locator(".sys-dock"), projectPath);
        await expect
          .poll(() => hostRecordState(host, projectPath))
          .not.toBe("recording");
      },
    );
  });
});
