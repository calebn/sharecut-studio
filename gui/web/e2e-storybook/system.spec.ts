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
  // The selected stage keeps its label.
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
  // Collapse sits at the trailing edge, and chapter rows run the card's width.
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
  // In the lower part of the sheet, not under the rows at the top.
  expect(button.y).toBeGreaterThan(sheet.y + sheet.height / 2);
});

test("System/Toast holds the toast at rest", async ({ page }) => {
  await open(page, "system-toast--result", 1280);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByText("Cut 3 words")).toBeVisible();
});
