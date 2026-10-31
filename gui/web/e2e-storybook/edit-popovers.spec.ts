import { devices, expect, test } from "@playwright/test";
import { newFinger } from "../e2e/finger";
import { storyUrl } from "./storyUrl";

/**
 * Real-layout checks for the Edit stage's touch-and-menu popovers. The jsdom
 * story run has no CSS, so the sizes the spec names are measured here.
 */

const LANE = "stages-edit-createmenu--lane";

async function open(
  page: import("@playwright/test").Page,
  id: string,
  width: number,
) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
}

async function coarsePage(
  browser: import("@playwright/test").Browser,
  id: string,
) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
  return { context, page };
}

const menu = (page: import("@playwright/test").Page) =>
  page.getByRole("menu", { name: "Create at 12:04.3 · Maya" });

/** Each row's rounded height, and whether the element at its four corners and centre is the row. */
function rowReach(page: import("@playwright/test").Page) {
  return page.getByRole("menuitem").evaluateAll((rows) =>
    rows.map((row) => {
      const r = row.getBoundingClientRect();
      const at = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest("[role=menuitem]") === row;
      const inset = 2;
      return {
        height: Math.round(r.height),
        hit:
          at(r.left + inset, r.top + inset) &&
          at(r.right - inset, r.top + inset) &&
          at(r.left + inset, r.bottom - inset) &&
          at(r.right - inset, r.bottom - inset) &&
          at(r.left + r.width / 2, r.top + r.height / 2),
      };
    }),
  );
}

test("Stages/Edit/CreateMenu is 220 px wide with a 32 px header and 36 px rows, above the held point and clear of it", async ({
  page,
}) => {
  await open(page, LANE, 1280);
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveCount(4);
  const box = await menu(page).boundingBox();
  expect(box?.width).toBe(220);
  const header = await page
    .locator(".edit-create-menu-title")
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(header).toBe(32);
  const reach = await rowReach(page);
  expect(reach.map((row) => row.height)).toEqual([36, 36, 36, 36]);
  expect(reach.every((row) => row.hit)).toBe(true);
  const dot = await page.locator(".edit-create-mark circle").boundingBox();
  if (!box || !dot) throw new Error("Menu did not render");
  await expect(menu(page)).toHaveAttribute("data-placement", "above");
  // The mark's circle (the held point) is a 24 px gap below the menu's foot.
  expect(dot.y + dot.height / 2 - (box.y + box.height)).toBeGreaterThanOrEqual(
    24,
  );
});

test("Stages/Edit/CreateMenu keeps 36 px rows and a 220 px width with Paste, and places it inside its box", async ({
  page,
}) => {
  await open(page, "stages-edit-createmenu--with-paste", 1280);
  await expect(page.getByRole("menuitem")).toHaveCount(5);
  expect((await menu(page).boundingBox())?.width).toBe(220);
  const reach = await rowReach(page);
  expect(reach.map((row) => row.height)).toEqual([36, 36, 36, 36, 36]);
  const inside = await menu(page).evaluate((el) => {
    const layer = el.closest(".edit-create-layer")?.parentElement;
    if (!layer) throw new Error("no box");
    const outer = layer.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return (
      r.left >= outer.left &&
      r.right <= outer.right &&
      r.top >= outer.top &&
      r.bottom <= outer.bottom
    );
  });
  expect(inside).toBe(true);
});

test("Stages/Edit/CreateMenu keeps the icon-to-label gap in a row with a shortcut hint, as in one without", async ({
  page,
}) => {
  await open(page, LANE, 1280);
  await expect(menu(page)).toBeVisible();
  const gaps = await page.getByRole("menuitem").evaluateAll((rows) =>
    rows.map((row) => {
      const icon = row.querySelector("svg");
      const label = row.querySelector(".ui-menu-item-label") ?? row;
      const range = document.createRange();
      const text = [...label.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (!icon || !text) throw new Error("Row has no icon or label text");
      range.selectNodeContents(text);
      return {
        hint: row.querySelector(".ui-menu-item-label") !== null,
        gap:
          range.getBoundingClientRect().left -
          icon.getBoundingClientRect().right,
      };
    }),
  );
  const hinted = gaps.filter((row) => row.hint);
  const plain = gaps.filter((row) => !row.hint);
  expect(hinted.length).toBeGreaterThan(0);
  expect(plain.length).toBeGreaterThan(0);
  for (const row of gaps) expect(row.gap).toBeGreaterThanOrEqual(8);
  for (const row of hinted)
    expect(Math.abs(row.gap - plain[0].gap)).toBeLessThanOrEqual(1);
});

test("Stages/Edit/CreateMenu has 44 px rows that take a touch at every corner under a coarse pointer", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(browser, LANE);
  await expect(menu(page)).toBeVisible();
  const reach = await rowReach(page);
  await context.close();
  expect(reach.map((row) => row.height)).toEqual([44, 44, 44, 44]);
  expect(reach.every((row) => row.hit)).toBe(true);
});

test("Stages/Edit/CreateMenu flips below a point near the top and clamps 16 px inside the side edge", async ({
  page,
}) => {
  await open(page, "stages-edit-createmenu--near-edge", 1280);
  await expect(page.getByRole("menu")).toBeVisible();
  const geometry = await page.getByRole("menu").evaluate((el) => {
    const layer = el.closest(".edit-create-layer");
    const box = layer?.parentElement;
    const dot = layer?.querySelector("circle");
    if (!box || !dot) throw new Error("no box");
    const outer = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const d = dot.getBoundingClientRect();
    return {
      placement: el.getAttribute("data-placement"),
      gap: r.top - (d.top + d.height / 2),
      right: outer.right - 1 - r.right,
      left: r.left - outer.left,
    };
  });
  expect(geometry.placement).toBe("below");
  expect(geometry.gap).toBe(24);
  expect(geometry.right).toBe(16);
  expect(geometry.left).toBeGreaterThanOrEqual(16);
});

test("Stages/Edit/CreateMenu on a phone is a content-height Sheet with 44 px rows and no grabber", async ({
  browser,
}) => {
  const { context, page } = await coarsePage(
    browser,
    "stages-edit-createmenu--phone",
  );
  await page.getByRole("button", { name: "Create here" }).click();
  const dialog = page.getByRole("dialog", { name: "12:04.3 · Maya" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".bottom-sheet-grabber")).toHaveCount(0);
  const rows = dialog.locator(".sys-row-btn");
  await expect(rows).toHaveCount(5);
  const heights = await rows.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  const sheet = await dialog.boundingBox();
  const viewport = page.viewportSize();
  await context.close();
  expect(heights).toEqual([44, 44, 44, 44, 44]);
  // Five 44 px rows and a header: far under the half detent, yet all rows show.
  expect(sheet?.height ?? 0).toBeGreaterThan(5 * 44);
  expect(sheet?.height ?? 0).toBeLessThan((viewport?.height ?? 0) * 0.5);
});

test("Stages/Edit/CreateMenu draws its time mark in the system highlight colour under forced colors", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl(LANE, { theme: "light" }));
  await expect(menu(page)).toBeVisible();
  const colors = await page.evaluate(() => {
    const stroke = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(selector);
      return getComputedStyle(el).stroke;
    };
    const probe = document.createElement("div");
    probe.style.forcedColorAdjust = "none";
    probe.style.backgroundColor = "Highlight";
    document.body.append(probe);
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const panel = document.querySelector(".edit-create-menu");
    if (!panel) throw new Error("no menu");
    return {
      highlight,
      line: stroke(".edit-create-mark line"),
      dot: stroke(".edit-create-mark circle"),
      border: getComputedStyle(panel).borderTopColor,
      well: getComputedStyle(panel).backgroundColor,
    };
  });
  expect(colors.line).toBe(colors.highlight);
  expect(colors.dot).toBe(colors.highlight);
  expect(colors.border).not.toBe(colors.well);
});

test("Stages/Edit/CreateMenu: Escape closes it and no window listener hears the key, and Tab out closes it", async ({
  page,
}) => {
  await open(page, LANE, 1280);
  await expect(menu(page)).toBeVisible();
  await expect(page.getByRole("menuitem").first()).toBeFocused();
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      heard.push(event.key);
    });
  });
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem").nth(3)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  const heard = await page.evaluate(
    () => (window as unknown as { heard: string[] }).heard,
  );
  // The menu takes Escape before any later window listener, such as the keymap.
  expect(heard).not.toContain("Escape");
  expect(heard).toContain("End");

  await page.getByRole("button", { name: "Open the menu again" }).click();
  await expect(menu(page)).toBeVisible();
  await page.getByRole("menuitem").last().focus();
  await page.keyboard.press("Tab");
  await expect(menu(page)).toHaveCount(0);
});

/*
 * Stages/Edit/TargetChooser. The story host is a fixture with a stub grammar
 * (hold, slide, lift), so these prove the leaf's geometry and its over, pick
 * and cancel contract under a real touch, not the app's hit router. Chromium
 * only: other engines may send a click after a lift to a different element.
 */

const CHOOSER = "stages-edit-targetchooser";
const CHIPS = "[data-target-id]";

type Page = import("@playwright/test").Page;
type Rect = { x: number; y: number; width: number; height: number };

async function touchPage(
  browser: import("@playwright/test").Browser,
  id: string,
  width = 393,
) {
  const context = await browser.newContext({
    ...devices["Pixel 5"],
    viewport: { width, height: 851 },
    baseURL: "http://127.0.0.1:6010",
  });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(storyUrl(id, { theme: "light" }));
  return { context, page };
}

async function box(page: Page): Promise<Rect> {
  const rect = await page.locator("[data-chooser-surface]").boundingBox();
  if (!rect) throw new Error("No press surface");
  return rect;
}

function chipRects(page: Page): Promise<(Rect & { id: string | null })[]> {
  return page.locator(CHIPS).evaluateAll((chips) =>
    chips.map((chip) => {
      const r = chip.getBoundingClientRect();
      return {
        id: chip.getAttribute("data-target-id"),
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    }),
  );
}

const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const readout = (page: Page) => page.locator("p[aria-live=polite]");

/** Presses `press` (in the surface) and holds until the fan is open there. */
async function holdOpen(
  page: Page,
  finger: Awaited<ReturnType<typeof newFinger>>,
  press: { x: number; y: number },
) {
  await finger.down(press);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("menu")).toBeVisible({ timeout: 2000 });
}

test("Stages/Edit/TargetChooser opens after a 500 ms hold with 44 px chips fanned 56 px above the finger, the outer ones 28 px clear of it", async ({
  browser,
  browserName,
}) => {
  const { context, page } = await touchPage(
    browser,
    `${CHOOSER}--four-targets`,
  );
  const finger = await newFinger(context, page, browserName);
  const surface = await box(page);
  const press = { x: surface.x + 180, y: surface.y + 270 };
  await holdOpen(page, finger, press);
  const chips = await chipRects(page);
  await finger.up();
  await context.close();
  expect(chips).toHaveLength(4);
  for (const chip of chips) {
    expect(chip.width).toBeCloseTo(44, 0);
    expect(chip.height).toBeCloseTo(44, 0);
  }
  // 52 px apart, centred on the press point.
  expect(chips.map((chip) => Math.round(centre(chip).x - press.x))).toEqual([
    -78, -26, 26, 78,
  ]);
  const [outer, inner] = [chips[0], chips[1]];
  expect(press.y - centre(outer).y).toBeCloseTo(50, 0);
  expect(press.y - centre(inner).y).toBeCloseTo(55.33, 0);
  for (const chip of chips) {
    expect(press.y - (chip.y + chip.height)).toBeGreaterThanOrEqual(27.5);
  }
  expect(press.y - (outer.y + outer.height)).toBeCloseTo(28, 0);
});

test("Stages/Edit/TargetChooser: sliding onto a chip marks it with its caption and lifting there picks it once", async ({
  browser,
  browserName,
}) => {
  const { context, page } = await touchPage(
    browser,
    `${CHOOSER}--four-targets`,
  );
  const finger = await newFinger(context, page, browserName);
  const surface = await box(page);
  await holdOpen(page, finger, { x: surface.x + 180, y: surface.y + 270 });
  const second = (await chipRects(page))[1];
  await finger.slide(centre(second), 6, 30);
  await expect(page.locator(`${CHIPS}.is-over`)).toHaveAttribute(
    "data-target-id",
    second.id ?? "",
  );
  await expect(page.locator(".edit-target-chooser-caption")).toHaveText(
    "Cut at 12:04.3",
  );
  await finger.up();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(readout(page)).toHaveText("Picked: Cut at 12:04.3");
  await expect(readout(page)).toHaveAttribute("data-picks", "1");
  await expect(readout(page)).toHaveAttribute("data-cancels", "0");
  await context.close();
});

test("Stages/Edit/TargetChooser: lifting anywhere but on a chip cancels and picks nothing", async ({
  browser,
  browserName,
}) => {
  const { context, page } = await touchPage(
    browser,
    `${CHOOSER}--four-targets`,
  );
  const finger = await newFinger(context, page, browserName);
  const surface = await box(page);
  const press = { x: surface.x + 180, y: surface.y + 270 };
  await holdOpen(page, finger, press);
  await finger.slide({ x: press.x, y: press.y + 30 }, 4, 30);
  await expect(page.locator(`${CHIPS}.is-over`)).toHaveCount(0);
  await finger.up();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(readout(page)).toHaveText("Cancelled");
  await expect(readout(page)).toHaveAttribute("data-picks", "0");
  await expect(readout(page)).toHaveAttribute("data-cancels", "1");
  await context.close();
});

test("Stages/Edit/TargetChooser: a finger that moves before the hold ends never opens it", async ({
  browser,
  browserName,
}) => {
  const { context, page } = await touchPage(browser, `${CHOOSER}--two-targets`);
  const finger = await newFinger(context, page, browserName);
  const surface = await box(page);
  const press = { x: surface.x + 180, y: surface.y + 270 };
  await finger.down(press);
  await page.waitForTimeout(150);
  await finger.move({ x: press.x + 14, y: press.y });
  await page.waitForTimeout(900);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await finger.up();
  await expect(readout(page)).toHaveText("");
  await context.close();
});

test("Stages/Edit/TargetChooser keeps its chips 16 px inside the box at a side edge without flipping", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser, `${CHOOSER}--near-edge`);
  await expect(page.getByRole("menu")).toBeVisible();
  const outer = await box(page);
  const chips = await chipRects(page);
  const placement = await page.getByRole("menu").getAttribute("data-placement");
  await context.close();
  expect(placement).toBe("above");
  expect(chips).toHaveLength(4);
  expect(chips[0].x - outer.x).toBeCloseTo(16, 0);
  for (const chip of chips) expect(chip.y).toBeGreaterThanOrEqual(outer.y);
});

test("Stages/Edit/TargetChooser flips below a point near the top, 28 px clear of it at the outer chips", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser, `${CHOOSER}--near-top`);
  await expect(page.getByRole("menu")).toBeVisible();
  const outer = await box(page);
  const chips = await chipRects(page);
  const placement = await page.getByRole("menu").getAttribute("data-placement");
  await context.close();
  expect(placement).toBe("below");
  const pressY = outer.y + 40;
  for (const chip of chips) {
    expect(chip.y - pressY).toBeGreaterThanOrEqual(27.5);
  }
});

test("Stages/Edit/TargetChooser on a phone holds five 44 px chips inside 16 px gutters, each taking a touch at every corner", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser, `${CHOOSER}--phone`, 360);
  await expect(page.getByRole("menu")).toBeVisible();
  const outer = await box(page);
  const reach = await page.locator(CHIPS).evaluateAll((chips) =>
    chips.map((chip) => {
      const r = chip.getBoundingClientRect();
      const at = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest("[data-target-id]") === chip;
      const inset = 4;
      return {
        size: [
          (chip as HTMLElement).offsetWidth,
          (chip as HTMLElement).offsetHeight,
        ],
        hit:
          at(r.left + r.width / 2, r.top + r.height / 2) &&
          at(r.left + inset, r.top + r.height / 2) &&
          at(r.right - inset, r.top + r.height / 2) &&
          at(r.left + r.width / 2, r.top + inset) &&
          at(r.left + r.width / 2, r.bottom - inset),
      };
    }),
  );
  const chips = await chipRects(page);
  await context.close();
  expect(reach.map((chip) => chip.size)).toEqual(Array(5).fill([44, 44]));
  expect(reach.every((chip) => chip.hit)).toBe(true);
  expect(chips[0].x - outer.x).toBeGreaterThanOrEqual(16);
  const last = chips[4];
  expect(outer.x + outer.width - (last.x + last.width)).toBeGreaterThanOrEqual(
    16,
  );
});

test("Stages/Edit/TargetChooser ellipsizes a long caption inside 15 rem on a phone", async ({
  browser,
}) => {
  const { context, page } = await touchPage(browser, `${CHOOSER}--phone`, 360);
  const caption = page.locator(".edit-target-chooser-caption");
  await expect(caption).toBeVisible();
  const measured = await caption.evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth,
    width: el.getBoundingClientRect().width,
    overflow: getComputedStyle(el).textOverflow,
    left: el.getBoundingClientRect().left,
    right: el.getBoundingClientRect().right,
  }));
  await context.close();
  expect(measured.clipped).toBe(true);
  expect(measured.overflow).toBe("ellipsis");
  expect(measured.width).toBeLessThanOrEqual(240);
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(360);
});

test("Stages/Edit/TargetChooser outlines the chip under a finger in the system highlight colour under forced colors, and keeps the ring", async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(storyUrl(`${CHOOSER}--four-targets`, { theme: "light" }));
  await expect(page.locator(`${CHIPS}.is-over`)).toBeVisible();
  const colors = await page.evaluate(() => {
    const probe = (property: "backgroundColor") => {
      const el = document.createElement("div");
      el.style.forcedColorAdjust = "none";
      el.style.backgroundColor = "Highlight";
      document.body.append(el);
      const value = getComputedStyle(el)[property];
      el.remove();
      return value;
    };
    const over = document.querySelector(".edit-target-chooser-chip.is-over");
    if (!over) throw new Error("no chip is over");
    const style = getComputedStyle(over);
    return {
      highlight: probe("backgroundColor"),
      outline: style.outlineColor,
      outlineWidth: style.outlineWidth,
      ring: style.borderTopColor,
      well: style.backgroundColor,
    };
  });
  expect(colors.outline).toBe(colors.highlight);
  expect(colors.outlineWidth).not.toBe("0px");
  expect(colors.ring).not.toBe(colors.well);
});

test("Stages/Edit/TargetChooser: Left, Right, Home and End move between chips, Escape cancels and no later window listener hears it, and Tab out cancels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(storyUrl(`${CHOOSER}--four-targets`, { theme: "light" }));
  const chips = page.getByRole("menuitem");
  await expect(chips.first()).toBeFocused();
  await page.evaluate(() => {
    const heard: string[] = [];
    Object.assign(window, { heard });
    window.addEventListener("keydown", (event) => {
      heard.push(event.key);
    });
  });
  await page.keyboard.press("ArrowRight");
  await expect(chips.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(chips.nth(3)).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(chips.first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(chips.nth(3)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(readout(page)).toHaveText("Cancelled");
  const heard = await page.evaluate(
    () => (window as unknown as { heard: string[] }).heard,
  );
  expect(heard).not.toContain("Escape");
  expect(heard).toContain("End");

  await page.getByRole("button", { name: "Open the chooser again" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem").last().focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(readout(page)).toHaveAttribute("data-cancels", "2");
});
