import { expect, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

/**
 * Real-layout checks for the System elements. The jsdom story run has no CSS,
 * so the sizes the design system names are measured here.
 */

async function open(
  page: import("@playwright/test").Page,
  id: string,
  width: number,
) {
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(storyUrl(id, { theme: "light" }));
}

test("System/AppHeader shows the stage labels at 1280", async ({ page }) => {
  await open(page, "system-appheader--host", 1280);
  const tab = page.getByRole("tab", { name: /^Prepare/ });
  await expect(tab).toBeVisible();
  const label = tab.locator(".sys-stage-label");
  const box = await label.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(30);
  expect((await tab.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(90);
});

test("System/AppHeader shows icons only for inactive stages under 1100", async ({
  page,
}) => {
  await open(page, "system-appheader--host", 900);
  const tab = page.getByRole("tab", { name: /^Prepare/ });
  await expect(tab).toBeVisible();
  const box = await tab.locator(".sys-stage-label").boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(2);
  const edit = await page
    .getByRole("tab", { name: /^Edit/ })
    .locator(".sys-stage-label")
    .boundingBox();
  expect(edit?.width ?? 0).toBeGreaterThan(20);
});

test("System/Player expanded form stretches across its card", async ({
  page,
}) => {
  await open(page, "system-player--expanded", 360);
  // The story's play collapses and re-expands the Player, so read all three
  // boxes in one step and retry until the expanded form is on screen.
  const measure = () =>
    page.evaluate(() => {
      const rect = (el: Element | null | undefined) => {
        const box = el?.getBoundingClientRect();
        return box ? { x: box.x, width: box.width } : null;
      };
      const buttons = [...document.querySelectorAll("button")];
      return {
        card: rect(document.querySelector(".sys-player--expanded")),
        collapse: rect(
          buttons.find(
            (b) => b.getAttribute("aria-label") === "Collapse player",
          ),
        ),
        row: rect(
          buttons.find((b) => b.textContent?.includes("The long way round")),
        ),
      };
    });
  type Boxes = Awaited<ReturnType<typeof measure>>;
  const seen: Boxes[] = [];
  await expect
    .poll(async () => {
      const m = await measure();
      if (m.card && m.collapse && m.row) seen.push(m);
      return seen.length;
    })
    .toBeGreaterThan(0);
  const { card, collapse, row } = seen[0];
  if (!card || !collapse || !row) throw new Error("Player did not render");
  expect(card.x + card.width - (collapse.x + collapse.width)).toBeLessThan(24);
  expect(row.width).toBeGreaterThan(card.width - 48);
});

test("System/Sheet phone footer is a 48 px full-width primary on a fine pointer", async ({
  page,
}) => {
  await open(page, "system-sheet--phone-half", 360);
  const dialog = page.getByRole("dialog", { name: "Mix" });
  await expect(dialog).toBeVisible();
  const done = page.getByRole("button", { name: "Done" });
  const sheet = await dialog.boundingBox();
  const button = await done.boundingBox();
  if (!sheet || !button) throw new Error("Sheet did not render");
  expect(button.height).toBeGreaterThanOrEqual(47.5);
  expect(button.width).toBeGreaterThan(sheet.width - 48);
  expect(button.y).toBeGreaterThan(sheet.y + sheet.height / 2);
});

test("System/Toast holds the toast at rest", async ({ page }) => {
  await page.clock.install();
  await open(page, "system-toast--result", 1280);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
  // Jump the page clock past the 10 s session-undo lifetime instead of waiting.
  await page.clock.fastForward(30_000);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
});

test("System/Menu rows with a shortcut set the icon apart from the label", async ({
  page,
}) => {
  await open(page, "system-menu--more", 1280);
  await page.getByRole("button", { name: "More" }).click();
  const row = page.getByRole("menuitem", { name: /Split/ });
  await expect(row).toBeVisible();
  const gap = await row.evaluate((el) => {
    const icon = el.querySelector("svg")?.getBoundingClientRect();
    const label = el.querySelector(".ui-menu-item-label");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let text: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent?.includes("Split")) text = n;
    }
    if (!icon || !label || !text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const box = range.getBoundingClientRect();
    const rowBox = el.getBoundingClientRect();
    return {
      apart: box.left - icon.right,
      iconMid: icon.top + icon.height / 2,
      textMid: box.top + box.height / 2,
      rowMid: rowBox.top + rowBox.height / 2,
    };
  });
  if (!gap) throw new Error("Menu row did not render");
  expect(gap.apart).toBeGreaterThanOrEqual(8);
  expect(Math.abs(gap.iconMid - gap.textMid)).toBeLessThanOrEqual(2);
  expect(Math.abs(gap.iconMid - gap.rowMid)).toBeLessThanOrEqual(2);
  expect(Math.abs(gap.textMid - gap.rowMid)).toBeLessThanOrEqual(2);
});

test("System controls show the 2 px accent focus ring", async ({ page }) => {
  await open(page, "system-cover--empty", 1280);
  await expect(page.locator("#storybook-root button").first()).toBeVisible();
  // Tab can land on the preview body while the story is still mounting, so
  // press it until a button inside the story holds focus.
  await expect(async () => {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active?.closest("#storybook-root") || active.tagName !== "BUTTON") {
        return null;
      }
      const style = getComputedStyle(active);
      return { width: style.outlineWidth, offset: style.outlineOffset };
    });
    expect(ring).toEqual({ width: "2px", offset: "2px" });
  }).toPass();
});

test("System/Player follow pill X has a 44 px hit area at 360", async ({
  page,
}) => {
  await open(page, "system-player--following", 360);
  const x = page.getByRole("button", { name: /^Stop following/ });
  await expect(x).toBeVisible();
  const box = await x.boundingBox();
  if (!box) throw new Error("Pill X did not render");
  const reach = await x.evaluate(
    (el, [dx, dy]) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2 + dx,
        r.top + r.height / 2 + dy,
      );
      return hit === el;
    },
    [20, 0],
  );
  expect(reach).toBe(true);
});
