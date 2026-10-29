import {
  type Browser,
  type CDPSession,
  devices,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { storyUrl } from "./storyUrl";

/**
 * Real-layout and real-pointer checks for System/InspectorSheet: the sizes the
 * design system names, the grip under a mouse and under CDP touch, hit tests
 * with elementFromPoint, the keyboard, and the media queries.
 */

const CARD = "system-inspectorsheet--desktop-card";
const PHONE_DOCK = "system-inspectorsheet--phone-dock";
const PHONE_HALF = "system-inspectorsheet--phone-half";

async function open(page: Page, id: string, width: number, height = 800) {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
}

async function coarsePage(browser: Browser, id: string) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(storyUrl(id, { theme: "light" }));
  return { context, page };
}

const sheet = (page: Page) => page.getByRole("dialog");
const grip = (page: Page) => page.getByRole("slider", { name: "Sheet height" });

async function box(locator: ReturnType<Page["locator"]>) {
  const found = await locator.boundingBox();
  if (!found) throw new Error("Not rendered");
  return found;
}

/** The sheet's height, measured and rounded to a tenth of a pixel. */
async function sheetHeight(page: Page) {
  return Math.round((await box(sheet(page))).height * 10) / 10;
}

/** Lets the finger rest: the sheet drops a flick once the pointer has been still for 80 ms. */
async function rest(page: Page, ms = 150) {
  const from = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    ([start, wait]) => performance.now() - (start ?? 0) >= (wait ?? 0),
    [from, ms],
  );
}

async function mouseDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { release = true } = {},
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await rest(page);
  if (release) await page.mouse.up();
}

async function touchSwipe(
  page: Page,
  cdp: CDPSession,
  from: { x: number; y: number },
  dy: number,
  { steps = 12 } = {},
) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  for (let step = 1; step <= steps; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x, y: from.y + (dy * step) / steps }],
    });
  }
  await rest(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

const centre = (b: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2,
});

test("System/InspectorSheet card is 320 wide with a 40 px header, sits 8 px below its anchor and has no Apply or Expand button", async ({
  page,
}) => {
  await open(page, CARD, 1280);
  const card = await box(sheet(page));
  const anchor = await box(page.getByTestId("inspector-anchor"));
  const header = await box(page.locator(".sys-inspector-header"));
  expect(card.width).toBe(320);
  expect(header.height).toBe(40);
  expect(card.y).toBe(anchor.y + anchor.height + 8);
  expect(card.x + card.width / 2).toBeCloseTo(anchor.x + anchor.width / 2, 0);
  await expect(
    page.getByRole("button", { name: /apply|expand|collapse/i }),
  ).toHaveCount(0);
});

test("System/InspectorSheet card flips above an anchor with no room below and hangs 8 px from it", async ({
  page,
}) => {
  await open(page, "system-inspectorsheet--tablet-card", 834, 900);
  const card = await box(sheet(page));
  const anchor = await box(page.getByTestId("inspector-anchor"));
  expect(card.y + card.height).toBe(anchor.y - 8);
});

test("System/InspectorSheet long content stops at 60 % of the box and scrolls inside, with the header staying put", async ({
  page,
}) => {
  await open(page, "system-inspectorsheet--long-content", 1280, 800);
  const card = await box(sheet(page));
  expect(card.height).toBe(480);
  const scroll = page.locator(".sys-inspector-scroll");
  const before = await box(page.locator(".sys-inspector-header"));
  const room = await scroll.evaluate((el) => {
    el.scrollTop = 200;
    return { scrollTop: el.scrollTop, over: el.scrollHeight - el.clientHeight };
  });
  expect(room.over).toBeGreaterThan(0);
  expect(room.scrollTop).toBe(200);
  expect(await box(page.locator(".sys-inspector-header"))).toEqual(before);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});

test("System/InspectorSheet rows are a 12 px secondary label on the left and a control on the right, and a section heading collapses its rows", async ({
  page,
}) => {
  await open(page, CARD, 1280);
  const label = page.locator(".sys-inspector-label").first();
  const field = page.getByRole("spinbutton", { name: "Start" });
  expect(await label.evaluate((el) => getComputedStyle(el).fontSize)).toBe(
    "12px",
  );
  expect((await box(label)).x).toBeLessThan((await box(field)).x);
  const before = await box(sheet(page));
  await page.getByRole("button", { name: "Timing" }).click();
  await expect(field).toBeHidden();
  expect((await box(sheet(page))).height).toBeLessThan(before.height);
  await page.getByRole("button", { name: "Timing" }).click();
  await expect(field).toBeVisible();
});

test("System/InspectorSheet keys: Tab walks header, headings and fields, Escape reverts a typed value first and then closes", async ({
  page,
}) => {
  await open(page, "system-inspectorsheet--closing", 1280);
  await page.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Offset", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("spinbutton", { name: "Offset" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.type("77");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("spinbutton", { name: "Offset" })).toBeFocused();
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reopen inspector" }),
  ).toBeVisible();
});

test("System/InspectorSheet card section headings and the close button are 44 px with a real hit under a coarse pointer", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, CARD);
  const targets = [
    page.getByRole("button", { name: "Timing" }),
    page.getByRole("button", { name: "Close" }),
  ];
  for (const target of targets) {
    const found = await box(target);
    expect(found.height).toBeGreaterThanOrEqual(44);
    expect(found.width).toBeGreaterThanOrEqual(44);
    const hits = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return [
        [0, 0],
        [0, -21],
        [0, 21],
        [-21, 0],
        [21, 0],
      ].map(
        ([dx, dy]) =>
          document
            .elementFromPoint(x + (dx ?? 0), y + (dy ?? 0))
            ?.closest("button") === el,
      );
    });
    expect(hits).toEqual([true, true, true, true, true]);
  }
  await context.close();
});

test("System/InspectorSheet phone dock is 64 px with a 36 by 5 grip whose 44 px hit area reaches above the sheet, and no Expand or Collapse button", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  expect(await sheetHeight(page)).toBe(64);
  const hit = await box(grip(page));
  const bar = await box(page.locator(".sys-inspector-grip-bar"));
  const top = await box(sheet(page));
  expect([hit.width, hit.height]).toEqual([44, 44]);
  expect([bar.width, bar.height]).toEqual([36, 5]);
  expect(hit.y).toBe(top.y - 36);
  expect(hit.y + hit.height).toBe(top.y + 8);
  expect(
    await grip(page).evaluate((el) => getComputedStyle(el).touchAction),
  ).toBe("none");
  await expect(
    page.getByRole("button", { name: /expand|collapse/i }),
  ).toHaveCount(0);
  const owners = await grip(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const at = (px: number, py: number) =>
      document.elementFromPoint(px, py)?.closest(".sys-inspector-grip") === el;
    return {
      inside: [
        at(x, r.top + 1),
        at(x, r.bottom - 1),
        at(r.left + 1, r.top + r.height / 2),
        at(r.right - 1, r.top + r.height / 2),
      ],
      below: at(x, r.bottom + 2),
      beside: at(r.left - 2, r.top + r.height / 2),
      above: at(x, r.top - 2),
    };
  });
  expect(owners).toEqual({
    inside: [true, true, true, true],
    below: false,
    beside: false,
    above: false,
  });
  const dockButton = page.getByRole("button", { name: "Hear" });
  const hear = await box(dockButton);
  expect(
    await dockButton.evaluate(
      (el, point) =>
        document.elementFromPoint(point.x, point.y)?.closest("button") === el,
      centre(hear),
    ),
  ).toBe(true);
});

test("System/InspectorSheet a mouse drag on the grip follows the pointer, settles on the detents and dismisses below the dock", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  const at = async () => centre(await box(grip(page)));
  const start = await at();
  await mouseDrag(
    page,
    start,
    { x: start.x, y: start.y - 330 },
    { release: false },
  );
  expect(await sheetHeight(page)).toBeCloseTo(64 + 330, 0);
  await expect(sheet(page)).toHaveAttribute("data-dragging", "");
  await page.mouse.up();
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  await expect.poll(() => sheetHeight(page)).toBe(370);

  const second = await at();
  await mouseDrag(page, second, { x: second.x, y: second.y - 280 });
  await expect(sheet(page)).toHaveAttribute("data-detent", "full");
  await expect.poll(() => sheetHeight(page)).toBe(680.8);

  const third = await at();
  await mouseDrag(page, third, { x: third.x, y: third.y + 600 });
  await expect(sheet(page)).toHaveAttribute("data-detent", "dock");
  await expect.poll(() => sheetHeight(page)).toBe(64);

  const fourth = await at();
  await mouseDrag(page, fourth, { x: fourth.x, y: fourth.y + 50 });
  await expect(sheet(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reopen inspector" }),
  ).toBeVisible();
});

test("System/InspectorSheet a slow drag that stops less than 24 px below the dock comes back to the dock", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  const start = centre(await box(grip(page)));
  await mouseDrag(page, start, { x: start.x, y: start.y + 14 });
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toHaveAttribute("data-detent", "dock");
  await expect.poll(() => sheetHeight(page)).toBe(64);
});

async function rootFontPx(page: Page, px: number) {
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}px`;
  }, px);
  await expect.poll(() => sheetHeight(page)).toBe(px * 4);
}

test("System/InspectorSheet at a 20 px root font the 4 rem dock is 80 px and a slow drag 30 px below it dismisses", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await rootFontPx(page, 20);
  const start = centre(await box(grip(page)));
  await mouseDrag(page, start, { x: start.x, y: start.y + 30 });
  await expect(sheet(page)).toHaveCount(0);
});

test("System/InspectorSheet at a 20 px root font a flick down from the dock dismisses and a drag to half settles on half of the box", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await rootFontPx(page, 20);
  const start = centre(await box(grip(page)));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 14, { steps: 4 });
  await page.mouse.up();
  await expect(sheet(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen inspector" }).click();
  await rootFontPx(page, 20);
  const again = centre(await box(grip(page)));
  await mouseDrag(page, again, { x: again.x, y: again.y - 280 });
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  await expect.poll(() => sheetHeight(page)).toBe(370);
});

test("System/InspectorSheet a click toggles half and dock, with a mouse and without moving", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await grip(page).click();
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Half height");
  await expect.poll(() => sheetHeight(page)).toBe(370);
  await grip(page).click();
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Dock");
  await expect.poll(() => sheetHeight(page)).toBe(64);
});

test("System/InspectorSheet Escape during a drag puts the sheet back and the release after it does nothing", async ({
  page,
}) => {
  await open(page, PHONE_HALF, 360, 740);
  const start = centre(await box(grip(page)));
  await mouseDrag(
    page,
    start,
    { x: start.x, y: start.y - 150 },
    { release: false },
  );
  await expect(sheet(page)).toHaveAttribute("data-dragging", "");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).not.toHaveAttribute("data-dragging", "");
  await page.mouse.up();
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  await expect.poll(() => sheetHeight(page)).toBe(370);
});

test("System/InspectorSheet the grip is a slider for the keyboard", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await grip(page).focus();
  await page.keyboard.press("ArrowUp");
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Half height");
  await page.keyboard.press("End");
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Full height");
  await page.keyboard.press("Enter");
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Half height");
  await page.keyboard.press("Home");
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Dock");
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
});

test("System/InspectorSheet at the dock the content cannot take focus, and at half Tab reaches it", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await grip(page).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => document.activeElement?.closest(".sys-inspector-content") !== null,
    ),
  ).toBe(false);
  await grip(page).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close" })).toBeFocused();
});

test("System/InspectorSheet under a coarse pointer a real tap on the grip toggles and a CDP swipe up and down moves between detents and dismisses", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, PHONE_DOCK);
  const cdp = await context.newCDPSession(page);
  const hit = await box(grip(page));
  expect([hit.width, hit.height]).toEqual([44, 44]);
  const owner = await grip(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return [
      [r.left + 4, r.top + 4],
      [r.right - 4, r.top + 4],
      [r.left + 4, r.bottom - 4],
      [r.right - 4, r.bottom - 4],
    ].map(
      ([x, y]) =>
        document
          .elementFromPoint(x ?? 0, y ?? 0)
          ?.closest(".sys-inspector-grip") === el,
    );
  });
  expect(owner).toEqual([true, true, true, true]);

  const tapAt = centre(hit);
  await page.touchscreen.tap(tapAt.x, tapAt.y);
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Half height");
  const frame = await box(page.getByTestId("inspector-frame"));
  const half = Math.round(frame.height * 0.5 * 10) / 10;
  await expect.poll(() => sheetHeight(page)).toBe(half);
  const raised = centre(await box(grip(page)));
  await page.touchscreen.tap(raised.x, raised.y);
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Dock");

  const from = centre(await box(grip(page)));
  await touchSwipe(page, cdp, from, -330);
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  await expect.poll(() => sheetHeight(page)).toBe(half);

  const mid = centre(await box(grip(page)));
  await touchSwipe(page, cdp, mid, 300);
  await expect(sheet(page)).toHaveAttribute("data-detent", "dock");

  const low = centre(await box(grip(page)));
  await touchSwipe(page, cdp, low, 50);
  await expect(sheet(page)).toHaveCount(0);
  await context.close();
});

test("System/InspectorSheet under a coarse pointer a vertical swipe on the grip does not scroll the page and a drag started elsewhere does not move the sheet", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, PHONE_HALF);
  const cdp = await context.newCDPSession(page);
  const top = await box(sheet(page));
  await touchSwipe(
    page,
    cdp,
    { x: top.x + top.width / 2, y: top.y + 120 },
    -60,
  );
  await expect(sheet(page)).toHaveAttribute("data-detent", "half");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await context.close();
});

test("System/InspectorSheet under reduced motion the height does not animate, and with motion it settles over --motion-panel", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  expect(
    await sheet(page).evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(
    await sheet(page).evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0.2s");
});

test("System/InspectorSheet under forced colors the grip bar and the focus ring use system colors", async ({
  page,
}) => {
  await open(page, PHONE_DOCK, 360, 740);
  await expect(grip(page)).toBeVisible();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const colors = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "ButtonText";
    document.body.append(probe);
    const buttonText = getComputedStyle(probe).color;
    probe.style.color = "Highlight";
    const highlight = getComputedStyle(probe).color;
    probe.remove();
    const bar = document.querySelector(".sys-inspector-grip-bar");
    const grip = document.querySelector<HTMLElement>(".sys-inspector-grip");
    grip?.focus();
    return {
      buttonText,
      highlight,
      bar: bar ? getComputedStyle(bar).backgroundColor : null,
      ring: grip ? getComputedStyle(grip).outlineColor : null,
    };
  });
  expect(colors.bar).toBe(colors.buttonText);
  expect(colors.ring).toBe(colors.highlight);
});

test("System/InspectorSheet in dark the sheet, the grip bar and the text come from the theme", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(storyUrl(PHONE_HALF, { theme: "dark" }));
  await expect(grip(page)).toBeVisible();
  const colors = await page.evaluate(() => {
    const surface = document.querySelector(".sys-inspector-surface");
    const bar = document.querySelector(".sys-inspector-grip-bar");
    const rgb = (value: string) =>
      (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    return {
      surface: rgb(surface ? getComputedStyle(surface).backgroundColor : ""),
      bar: rgb(bar ? getComputedStyle(bar).backgroundColor : ""),
    };
  });
  const luminance = (c: number[]) => (c[0] ?? 0) + (c[1] ?? 0) + (c[2] ?? 0);
  expect(luminance(colors.surface)).toBeLessThan(300);
  expect(luminance(colors.bar)).toBeGreaterThan(luminance(colors.surface));
});

const TRANSPARENT = "rgba(0, 0, 0, 0)";

test("System/InspectorSheet and the Action bar phone dock both paint their grip bar", async ({
  page,
}) => {
  const bar = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
  await open(page, "system-actionbar--phone-dock", 390, 740);
  expect(await bar(".sys-actions-grip")).not.toBe(TRANSPARENT);
  await open(page, "system-actionbar--phone-dock-390", 390, 740);
  expect(await bar(".sys-actions-grip")).not.toBe(TRANSPARENT);
  await open(page, PHONE_DOCK, 360, 740);
  expect(
    await page
      .locator(".sys-inspector-grip-bar")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe(TRANSPARENT);
});

test("System/InspectorSheet a fast flick down from half lands on the dock and does not dismiss", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, PHONE_HALF);
  const cdp = await context.newCDPSession(page);
  const from = centre(await box(grip(page)));
  const flick = async () => {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    for (const dy of [20, 60, 120, 150]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y: from.y + dy }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await flick();
  await expect(sheet(page)).toHaveAttribute("data-detent", "dock");
  await expect.poll(() => sheetHeight(page)).toBe(64);
  await context.close();
});

test("System/InspectorSheet a finger tap on the grip that drifts 5 px still toggles", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, PHONE_DOCK);
  const cdp = await context.newCDPSession(page);
  const from = centre(await box(grip(page)));
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: from.x, y: from.y + 5 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(grip(page)).toHaveAttribute("aria-valuetext", "Half height");
  await context.close();
});

test("System/InspectorSheet the inline rename ignores Enter and Escape while an IME composition is open", async ({
  page,
}) => {
  await open(page, CARD, 1280);
  const cdp = await page.context().newCDPSession(page);
  const name = page.getByRole("textbox", { name: "Name" });
  await name.focus();
  await name.selectText();
  await cdp.send("Input.imeSetComposition", {
    text: "にほん",
    selectionStart: 3,
    selectionEnd: 3,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    windowsVirtualKeyCode: 229,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    windowsVirtualKeyCode: 229,
  });
  await expect(name).toHaveValue("にほん");
  await expect(sheet(page)).toHaveAccessibleName("Maya · 12:04 to 12:23");
  await cdp.send("Input.insertText", { text: "にほん" });
  await name.press("Enter");
  await expect(sheet(page)).toHaveAccessibleName("にほん");
});
