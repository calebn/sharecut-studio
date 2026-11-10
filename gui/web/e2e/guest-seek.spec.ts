import fs from "node:fs";
import path from "node:path";
import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { newFinger } from "./finger";
import { playButton } from "./playback";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";
import { parseTimecodeSec } from "./timecode";
import { withBrowserPages } from "./twoBrowserPages";

/**
 * A guest seeks the expanded Player through its Episode overview slider, and a
 * comment row plays its clip. The fixture episode is 60 s, so a fraction of the
 * strip is a whole number of seconds within a pixel's slack.
 */

const DURATION_SEC = 60;
/** One strip pixel is under 0.1 s at the narrowest strip here. */
const SEEK_SLACK_SEC = 0.5;
const COMMENT_AT_SEC = 20;

const DESKTOP = { width: 1280, height: 800, touch: false } as const;
const PHONE = { width: 390, height: 844, touch: true } as const;
type Size = typeof DESKTOP | typeof PHONE;
type Theme = "light" | "dark";

interface Guest {
  page: Page;
  strip: Locator;
  clock: Locator;
}

/** A mono 16-bit WAV whose level steps up block by block, so its envelope is not flat. */
function steppedToneWav(seconds = 8, sampleRate = 8000): Buffer {
  const n = seconds * sampleRate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) {
    const level = (1 + Math.floor((i / n) * 8)) / 8;
    const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * level;
    buf.writeInt16LE(Math.round(sample * 0.9 * 32767), 44 + i * 2);
  }
  return buf;
}

async function withGuest(
  browser: Browser,
  size: Size,
  theme: Theme,
  run: (guest: Guest) => Promise<void>,
  options: { tone?: boolean } = {},
): Promise<void> {
  await withShareableProject(async (projectPath) => {
    if (options.tone) {
      fs.writeFileSync(
        path.join(path.dirname(projectPath), "artifacts", "premix.wav"),
        steppedToneWav(),
      );
    }
    await withBrowserPages(
      browser,
      [
        {},
        {
          viewport: { width: size.width, height: size.height },
          deviceScaleFactor: 1,
          colorScheme: theme,
          reducedMotion: "reduce",
          hasTouch: size.touch,
          isMobile: size.touch,
        },
      ],
      async ([host, page]) => {
        await openHostShare(host, projectPath);
        const token = await createReviewShare(host, projectPath, "commenter");
        await openGuestShare(page, token);
        if (size.touch)
          await page.getByRole("button", { name: /Expand player/ }).tap();
        const strip = page
          .locator(".sys-player--expanded")
          .getByRole("slider", { name: "Episode overview", exact: true });
        await expect(strip).toBeVisible();
        await run({
          page,
          strip,
          clock: page.locator(".sys-player-now"),
        });
      },
    );
  });
}

async function now(guest: Guest): Promise<number> {
  return parseTimecodeSec(await guest.clock.innerText());
}

async function expectClockNear(guest: Guest, seconds: number): Promise<void> {
  await expect
    .poll(async () => Math.abs((await now(guest)) - seconds), {
      message: `clock within ${SEEK_SLACK_SEC}s of ${seconds}s`,
    })
    .toBeLessThan(SEEK_SLACK_SEC);
}

/** The strip's point at `fraction` of its width, centred vertically. */
async function stripPoint(strip: Locator, fraction: number) {
  await strip.scrollIntoViewIfNeeded();
  const box = (await strip.boundingBox())!;
  return {
    x: box.x + box.width * fraction,
    y: box.y + box.height / 2,
  };
}

async function clickStrip(guest: Guest, fraction: number): Promise<void> {
  const at = await stripPoint(guest.strip, fraction);
  await guest.page.mouse.click(at.x, at.y);
  await expectClockNear(guest, fraction * DURATION_SEC);
}

async function mouseDragStrip(
  guest: Guest,
  from: number,
  to: number,
): Promise<void> {
  const start = await stripPoint(guest.strip, from);
  const end = await stripPoint(guest.strip, to);
  await guest.page.mouse.move(start.x, start.y);
  await guest.page.mouse.down();
  await guest.page.mouse.move(end.x, end.y, { steps: 12 });
}

async function proof(guest: Guest, name: string): Promise<void> {
  const dir = process.env.SEEK_PROOF_DIR;
  const file = dir
    ? path.join(dir, `${name}.png`)
    : test.info().outputPath(`${name}.png`);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  await guest.page.screenshot({ path: file });
}

/**
 * Post a comment anchored at the playhead. The posted comment is selected; its
 * queue row and its thread card each play the clip.
 */
async function postCommentAt(guest: Guest, seconds: number) {
  await clickStrip(guest, seconds / DURATION_SEC);
  const at = await now(guest);
  const compose = guest.page.locator(".rv-compose");
  await compose
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("Tighten this pause");
  await compose.getByRole("button", { name: "Post", exact: true }).click();
  const row = guest.page
    .locator('.sys-queue-row[data-kind="comment"]')
    .filter({ hasText: "Tighten this pause" });
  await expect(row).toHaveCount(1);
  return {
    at,
    row: row.locator(".sys-queue-main"),
    card: guest.page.locator(".sys-comment-main"),
  };
}

/** Lets the page paint a run of frames, so a "stays put" check observes real rendering, not a clock. */
const SETTLE_FRAMES = 30;
function settleFrames(page: Page): Promise<void> {
  return page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SETTLE_FRAMES,
  );
}

test("the expanded Player shows the 60 s total duration on a phone", async ({
  browser,
}) => {
  await withGuest(browser, PHONE, "light", async (guest) => {
    const total = guest.page.locator(".sys-player--expanded .sys-player-total");
    await expect(total).toBeVisible();
    await expect(total).toContainText("01:00");
  });
});

test("the guest overview strip draws the episode, not a flat line", async ({
  browser,
}) => {
  await withGuest(
    browser,
    DESKTOP,
    "light",
    async (guest) => {
      const bars = guest.page.locator(
        ".sys-player--expanded .sys-overview-peak",
      );
      const heights = async () =>
        bars.evaluateAll((els) =>
          els.map((el) => Number(el.getAttribute("height"))),
        );
      await expect
        .poll(async () => (await heights()).length, {
          message: "one bar per peak, not the single flat line",
        })
        .toBeGreaterThan(64);
      await expect
        .poll(
          async () => {
            const h = await heights();
            return Math.max(...h) - Math.min(...h);
          },
          { message: "bar heights vary along the strip" },
        )
        .toBeGreaterThan(0.2);
    },
    { tone: true },
  );
});

test("a click on the strip at 73% puts the clock at 73% of the episode", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    await clickStrip(guest, 0.73);
    await expect(guest.strip).toHaveAttribute(
      "aria-valuenow",
      String(Math.round(0.73 * DURATION_SEC)),
    );
  });
});

test("a mouse drag from 25% to 60% moves the clock with it and release keeps it", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    await mouseDragStrip(guest, 0.25, 0.6);
    await expectClockNear(guest, 0.6 * DURATION_SEC);
    await guest.page.mouse.up();
    await settleFrames(guest.page);
    await expectClockNear(guest, 0.6 * DURATION_SEC);
  });
});

test("Escape during a drag puts the clock back where the drag began", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    await clickStrip(guest, 0.1);
    await mouseDragStrip(guest, 0.25, 0.6);
    await expectClockNear(guest, 0.6 * DURATION_SEC);
    await guest.page.keyboard.press("Escape");
    await expectClockNear(guest, 0.1 * DURATION_SEC);
    await guest.page.mouse.up();
    await settleFrames(guest.page);
    await expectClockNear(guest, 0.1 * DURATION_SEC);
  });
});

test("ArrowRight and ArrowLeft move the clock exactly one second", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    await clickStrip(guest, 0.5);
    const from = await now(guest);
    await guest.strip.focus();
    await guest.page.keyboard.press("ArrowRight");
    await expect.poll(() => now(guest)).toBeCloseTo(from + 1, 2);
    await settleFrames(guest.page);
    expect(await now(guest)).toBeCloseTo(from + 1, 2);
    await guest.page.keyboard.press("ArrowLeft");
    await expect.poll(() => now(guest)).toBeCloseTo(from, 2);
    await settleFrames(guest.page);
    expect(await now(guest)).toBeCloseTo(from, 2);
  });
});

test("a comment row seeks to its time and its clip plays and stops 2 s after it, unless a strip click or Pause overrides the stop", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    const { at, row, card } = await postCommentAt(guest, COMMENT_AT_SEC);
    const pause = guest.page.getByRole("button", {
      name: "Pause",
      exact: true,
    });
    const play = playButton(guest.page);

    await clickStrip(guest, 0.8);
    await row.click();
    await expect(pause).toBeVisible();
    expect(await now(guest)).toBeGreaterThan(at - 2 - SEEK_SLACK_SEC);
    expect(await now(guest)).toBeLessThan(at + 2 + SEEK_SLACK_SEC);
    await expect(play).toBeVisible({ timeout: 8_000 });
    await expectClockNear(guest, at + 2);

    // A strip click during the clip clears its stop: play runs on past it.
    await card.click();
    await expect(pause).toBeVisible();
    const middle = await stripPoint(guest.strip, 0.5);
    await guest.page.mouse.click(middle.x, middle.y);
    await expect
      .poll(() => now(guest), { timeout: 8_000 })
      .toBeGreaterThan(0.5 * DURATION_SEC + 3);
    await expect(pause).toBeVisible();

    await pause.click();
    await expect(play).toBeVisible();
    const held = await now(guest);
    await settleFrames(guest.page);
    expect(await now(guest)).toBe(held);
  });
});

test("Pause during a comment clip stops it, and the next Play is not cut at the old clip end", async ({
  browser,
}) => {
  await withGuest(browser, DESKTOP, "light", async (guest) => {
    const { row } = await postCommentAt(guest, COMMENT_AT_SEC);
    const pause = guest.page.getByRole("button", {
      name: "Pause",
      exact: true,
    });
    await row.click();
    await expect(pause).toBeVisible();
    await pause.click();
    await expect(playButton(guest.page)).toBeVisible();
    const held = await now(guest);
    await settleFrames(guest.page);
    expect(await now(guest)).toBe(held);
    await clickStrip(guest, 0.5);
    await playButton(guest.page).click();
    await expect
      .poll(() => now(guest), { timeout: 8_000 })
      .toBeGreaterThan(0.5 * DURATION_SEC + 3);
    await expect(pause).toBeVisible();
  });
});

test("a finger tap on the strip at 73% seeks on a phone", async ({
  browser,
}) => {
  await withGuest(browser, PHONE, "light", async (guest) => {
    await guest.strip.scrollIntoViewIfNeeded();
    const at = await stripPoint(guest.strip, 0.73);
    await guest.page.touchscreen.tap(at.x, at.y);
    await expectClockNear(guest, 0.73 * DURATION_SEC);
  });
});

test("a finger drag from 25% to 60% moves the clock with it and lifting keeps it on a phone", async ({
  browser,
  browserName,
}) => {
  await withGuest(browser, PHONE, "light", async (guest) => {
    const finger = await newFinger(
      guest.page.context(),
      guest.page,
      browserName,
    );
    const from = await stripPoint(guest.strip, 0.25);
    const to = await stripPoint(guest.strip, 0.6);
    await finger.down(from);
    await finger.slide(to, 12, 16);
    await expectClockNear(guest, 0.6 * DURATION_SEC);
    await finger.up();
    await settleFrames(guest.page);
    await expectClockNear(guest, 0.6 * DURATION_SEC);
  });
});

for (const size of [DESKTOP, PHONE]) {
  for (const theme of ["light", "dark"] as const) {
    const kind = size === DESKTOP ? "desktop" : "phone";
    test(`proof screenshots: strip focused, mid-drag and after a seek, ${kind} ${theme}`, async ({
      browser,
      browserName,
    }) => {
      await withGuest(browser, size, theme, async (guest) => {
        const stem = `guest-seek-${kind}-${size.width}x${size.height}-${theme}`;
        await guest.strip.scrollIntoViewIfNeeded();
        await guest.page.keyboard.press("Tab");
        await guest.strip.focus();
        await guest.page.keyboard.press("ArrowRight");
        await guest.page.keyboard.press("ArrowLeft");
        await expect(guest.strip).toBeFocused();
        await proof(guest, `${stem}-1-strip-focused`);

        const from = await stripPoint(guest.strip, 0.25);
        const to = await stripPoint(guest.strip, 0.6);
        if (size.touch) {
          const finger = await newFinger(
            guest.page.context(),
            guest.page,
            browserName,
          );
          await finger.down(from);
          await finger.slide(to, 12, 16);
          await expectClockNear(guest, 0.6 * DURATION_SEC);
          await proof(guest, `${stem}-2-mid-drag`);
          await finger.up();
        } else {
          await mouseDragStrip(guest, 0.25, 0.6);
          await expectClockNear(guest, 0.6 * DURATION_SEC);
          await proof(guest, `${stem}-2-mid-drag`);
          await guest.page.mouse.up();
        }

        await clickStrip(guest, 0.73);
        await proof(guest, `${stem}-3-after-seek`);
      });
    });
  }
}
