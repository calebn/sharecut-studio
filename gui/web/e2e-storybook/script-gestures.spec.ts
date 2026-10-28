import {
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { storyUrl } from "./storyUrl";

/**
 * The Script pane's selection gestures with a real mouse and real CDP touch
 * events (design-system element 14). jsdom has no layout and no touch
 * arbitration, so the hit tests, the swipe against the long press, the edge
 * scroll and the native text selection are proved here.
 */

const GESTURES = "system-scriptpane--gestures";
const PHONE = "system-scriptpane--phone-gestures";

const stop = (page: Page, index: number) =>
  page.locator(`[data-stop="${index}"]`);

async function centre(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Not drawn");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function openDesktop(page: Page, id = GESTURES) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
  await expect(stop(page, 0)).toBeVisible();
}

async function touchPage(browser: Browser, id = PHONE) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.goto(storyUrl(id, { theme: "light" }));
  await expect(stop(page, 0)).toBeVisible();
  return { context, page };
}

/** Real touch points through the browser's own input pipeline, so scrolling and the pointer cancel it causes are the real ones. */
async function finger(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd",
    point?: { x: number; y: number },
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
    });
  return {
    down: (point: { x: number; y: number }) => send("touchStart", point),
    move: async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      steps = 8,
    ) => {
      for (let step = 1; step <= steps; step += 1) {
        await send("touchMove", {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        });
      }
    },
    up: () => send("touchEnd"),
  };
}

const selected = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".sys-script-word[data-selected]")].map(
      (el) => el.textContent,
    ),
  );

const bodyScroll = (page: Page) =>
  page.evaluate(
    () => document.querySelector(".sys-script-body")?.scrollTop ?? -1,
  );

test("a real mouse drag selects the words it crosses, across a turn boundary, and commits on release", async ({
  page,
}) => {
  await openDesktop(page);
  const from = await centre(stop(page, 18));
  const to = await centre(stop(page, 22));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect(page.locator(".sys-script-body")).toHaveAttribute(
    "data-selecting",
    "",
  );
  await expect(page.getByRole("status")).toHaveText("");
  const head = await page.evaluate(
    ([x, y]) =>
      document.elementFromPoint(x, y)?.closest("[data-stop]")?.textContent,
    [to.x, to.y],
  );
  expect(head).toBe("having");
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText(
    "5 words selected: large one. Thanks for having",
  );
  expect(await selected(page)).toEqual([
    "large",
    "one.",
    "Thanks",
    "for",
    "having",
  ]);
  await expect(stop(page, 22)).toBeFocused();
});

test("a drag leaves the browser's own text selection empty and the words unselectable", async ({
  page,
}) => {
  await openDesktop(page);
  const from = await centre(stop(page, 2));
  const to = await centre(stop(page, 9));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const native = await page.evaluate(() => ({
    text: window.getSelection()?.toString() ?? "",
    userSelect: getComputedStyle(
      document.querySelector(".sys-script-body") as Element,
    ).userSelect,
    touchAction: getComputedStyle(
      document.querySelector(".sys-script-body") as Element,
    ).touchAction,
  }));
  expect(native).toEqual({
    text: "",
    userSelect: "none",
    touchAction: "manipulation",
  });
});

test("Shift-click extends from the clicked word, and a plain click selects one word at once", async ({
  page,
}) => {
  await openDesktop(page);
  await stop(page, 12).click();
  expect(await selected(page)).toEqual(["small"]);
  await stop(page, 15).click({ modifiers: ["Shift"] });
  expect(await selected(page)).toEqual(["small", "room", "can", "sound"]);
});

test("a double-click starts Fix text and a single click does not", async ({
  page,
}) => {
  await openDesktop(page);
  await stop(page, 12).click();
  await expect(page.getByRole("textbox", { name: "Fix text" })).toHaveCount(0);
  await stop(page, 12).dblclick();
  await expect(page.getByRole("textbox", { name: "Fix text" })).toBeVisible();
});

test("Esc in the middle of a drag cancels it and the earlier selection stays", async ({
  page,
}) => {
  await openDesktop(page);
  await stop(page, 0).click();
  const from = await centre(stop(page, 12));
  const to = await centre(stop(page, 15));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  expect(await selected(page)).toEqual(["small", "room", "can", "sound"]);
  await page.keyboard.press("Escape");
  expect(await selected(page)).toEqual(["Welcome"]);
  await page.mouse.up();
  expect(await selected(page)).toEqual(["Welcome"]);
  await expect(page.getByRole("list", { name: /told the host/ })).toContainText(
    "end 12 to 15 cancelled",
  );
});

test("a drag near the bottom edge scrolls the pane and keeps selecting, then stops where the pointer stops", async ({
  page,
}) => {
  await openDesktop(page, "system-scriptpane--long-gestures");
  const body = page.locator(".sys-script-body");
  const box = await body.boundingBox();
  if (!box) throw new Error("No body");
  const from = await centre(stop(page, 30));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, box.y + box.height - 8, { steps: 6 });
  await expect.poll(() => bodyScroll(page)).toBeGreaterThan(80);
  await page.mouse.move(from.x, box.y + box.height / 2, { steps: 3 });
  const rested = await bodyScroll(page);
  await expect.poll(() => bodyScroll(page)).toBe(rested);
  await page.mouse.up();
  const count = await page.evaluate(
    () => document.querySelectorAll(".sys-script-word[data-selected]").length,
  );
  expect(count).toBeGreaterThan(30);
  await expect(page.getByRole("status")).toHaveText(/^\d+ words selected: /);
});

test("a drag out of the pane keeps selecting to the nearest word, and the capture ends it on release outside", async ({
  page,
}) => {
  await openDesktop(page);
  const from = await centre(stop(page, 12));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 8 });
  await page.mouse.up();
  const words = await selected(page);
  expect(words.length).toBeGreaterThan(1);
  expect(words).toContain("small");
});

test("a right-to-left turn selects by reading order and the grips sit at the right edge of its first word", async ({
  page,
}) => {
  await openDesktop(page, "system-scriptpane--rtl-gestures");
  const first = await centre(stop(page, 7));
  const last = await centre(stop(page, 10));
  expect(last.x).toBeLessThan(first.x);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(last.x, last.y, { steps: 8 });
  await page.mouse.up();
  expect(await selected(page)).toEqual(["לכולם", "ברוכים", "הבאים", "להקלטה"]);
  const start = await page
    .locator(".sys-handle[data-edge=start]")
    .boundingBox();
  const word = await stop(page, 7).boundingBox();
  if (!start || !word) throw new Error("Nothing drawn");
  expect(
    Math.abs(start.x + start.width / 2 - (word.x + word.width)),
  ).toBeLessThanOrEqual(2);
});

test("selected words stay visible in forced colours and in dark mode", async ({
  page,
}) => {
  await openDesktop(page);
  await stop(page, 12).click();
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await stop(page, 12).evaluate((el) => {
    const style = getComputedStyle(el);
    return style.outlineStyle !== "none" && style.outlineWidth !== "0px";
  });
  expect(forced).toBe(true);
  await page.emulateMedia({ forcedColors: "none", colorScheme: "dark" });
  const dark = await stop(page, 12).evaluate((el) => ({
    selected: getComputedStyle(el).backgroundColor,
    plain: getComputedStyle(
      document.querySelector('[data-stop="13"]') as Element,
    ).backgroundColor,
  }));
  expect(dark.selected).not.toBe(dark.plain);
});

test("a huge turn selects from its first word to a far one in reasonable time", async ({
  page,
}) => {
  await openDesktop(page, "system-scriptpane--huge-gestures");
  await stop(page, 0).click();
  const far = stop(page, 1000);
  await far.scrollIntoViewIfNeeded();
  const started = Date.now();
  await far.click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status")).toHaveText(/^1001 words selected: /);
  expect(Date.now() - started).toBeLessThan(4000);
});

test("on a phone a tap selects a word, a double tap starts Fix text, and nothing overflows at 360", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser);
  const point = await centre(stop(page, 12));
  await page.touchscreen.tap(point.x, point.y);
  expect(await selected(page)).toEqual(["small"]);
  await expect(page.getByRole("textbox", { name: "Fix text" })).toHaveCount(0);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.getByRole("textbox", { name: "Fix text" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test("on a phone a swipe scrolls the pane and selects nothing", async ({
  browser,
}) => {
  const { context, page } = await touchPage(
    browser,
    "system-scriptpane--long-gestures",
  );
  const touch = await finger(context, page);
  const from = await centre(stop(page, 30));
  await touch.down(from);
  await touch.move(from, { x: from.x, y: from.y - 160 }, 10);
  await touch.up();
  await expect.poll(() => bodyScroll(page)).toBeGreaterThan(40);
  expect(await selected(page)).toEqual([]);
  await expect(page.locator(".sys-handle")).toHaveCount(0);
  await context.close();
});

test("on a phone a long press selects the word and a drag extends it without scrolling, then the grips show", async ({
  browser,
}) => {
  const { context, page } = await touchPage(
    browser,
    "system-scriptpane--long-gestures",
  );
  const touch = await finger(context, page);
  const from = await centre(stop(page, 30));
  const before = await bodyScroll(page);
  await touch.down(from);
  await expect(stop(page, 30)).toHaveAttribute("data-selected", "");
  const to = await centre(stop(page, 52));
  await touch.move(from, to, 10);
  await touch.up();
  await expect(page.getByRole("status")).toHaveText(/^23 words selected: /);
  expect(await bodyScroll(page)).toBe(before);
  await expect(page.locator(".sys-handle")).toHaveCount(2);
  await context.close();
});

test("on a phone a hold that never moves selects that word and shows its grips", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser);
  const touch = await finger(context, page);
  const from = await centre(stop(page, 12));
  await touch.down(from);
  await expect(stop(page, 12)).toHaveAttribute("data-selected", "");
  await touch.up();
  await expect(page.getByRole("status")).toHaveText("1 word selected: small");
  await expect(page.locator(".sys-handle")).toHaveCount(2);
  await context.close();
});

/** A finger that drifts inside the 10 px slop before the hold arms, as a real one does. */
async function driftThenDrag(browser: Browser, drift: number) {
  const { context, page } = await touchPage(
    browser,
    "system-scriptpane--long-gestures",
  );
  const touch = await finger(context, page);
  const from = await centre(stop(page, 30));
  const before = await bodyScroll(page);
  await touch.down(from);
  await touch.move(from, { x: from.x, y: from.y + drift }, drift);
  await expect(stop(page, 30)).toHaveAttribute("data-selected", "");
  const to = await centre(stop(page, 52));
  await touch.move({ x: from.x, y: from.y + drift }, to, 10);
  await touch.up();
  await expect(page.getByRole("status")).toHaveText(/^23 words selected: /);
  expect(await bodyScroll(page)).toBe(before);
  await expect(page.locator(".sys-handle")).toHaveCount(2);
  await context.close();
}

test("on a phone a finger that drifts 3 px before the hold still drags the selection out, and the pane does not scroll", async ({
  browser,
}) => {
  await driftThenDrag(browser, 3);
});

test("on a phone a finger that drifts 8 px before the hold still drags the selection out, and the pane does not scroll", async ({
  browser,
}) => {
  await driftThenDrag(browser, 8);
});
