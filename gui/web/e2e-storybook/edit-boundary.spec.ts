import { expect, type Locator, test } from "@playwright/test";

async function paragraphGeometry(paragraph: Locator) {
  return paragraph.evaluate((element) => {
    const textRects = Array.from(element.childNodes)
      .filter(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      )
      .flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects(), (rect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }));
      });
    return { height: element.getBoundingClientRect().height, textRects };
  });
}

for (const width of [1440, 360]) {
  for (const theme of ["light", "dark"]) {
    for (const story of ["roll-join", "trim-edge"]) {
      test(`${story} preserves drag geometry at ${width}px in ${theme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(
          `/iframe.html?id=templates-editboundarymark--${story}&viewMode=story&globals=theme:${theme}`,
        );
        const mark = page.locator("button[data-boundary-id]");
        await expect(mark).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.evaluate(() => document.fonts.ready);
        const paragraph = page.locator(".utterance-seg");
        const originalParagraph = await paragraphGeometry(paragraph);
        if (width === 360) {
          expect(
            new Set(originalParagraph.textRects.map((rect) => rect.y)).size,
          ).toBeGreaterThanOrEqual(2);
        }
        const origin = await mark.boundingBox();
        if (!origin) throw new Error("Boundary has no rendered rectangle");
        const grabOffset = origin.width * 0.35;
        const startX = origin.x + grabOffset;
        const startY = origin.y + origin.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await expect(mark).toHaveAttribute("aria-grabbed", "true");
        for (const dx of [0, 4, 8, 16, 32, 64, 80, 32, 0, -4, -16, -64, 0]) {
          await page.mouse.move(startX + dx, startY);
          await expect
            .poll(async () => (await mark.boundingBox())?.x)
            .toBeCloseTo(origin.x + dx, 1);
          const actual = await mark.boundingBox();
          if (!actual) throw new Error("Boundary disappeared during drag");
          expect(actual.width).toBeCloseTo(origin.width, 2);
          expect(actual.y).toBeCloseTo(origin.y, 2);
          expect(actual.height).toBeCloseTo(origin.height, 2);
          expect(startX + dx - actual.x).toBeCloseTo(grabOffset, 1);
          expect(await paragraphGeometry(paragraph)).toEqual(originalParagraph);
          if (dx === 80) {
            const ghosts = page.getByRole("group", {
              name: "Preview restored words",
            });
            await expect(ghosts).toContainText("before");
            const preview = await page
              .locator(".edit-boundary-preview")
              .boundingBox();
            if (!preview)
              throw new Error("Restored-word preview has no rectangle");
            expect(preview.x).toBeGreaterThanOrEqual(0);
            expect(preview.y).toBeGreaterThanOrEqual(0);
            expect(preview.x + preview.width).toBeLessThanOrEqual(width);
            expect(preview.y + preview.height).toBeLessThanOrEqual(900);
            const overlaps =
              preview.x < actual.x + actual.width &&
              preview.x + preview.width > actual.x &&
              preview.y < actual.y + actual.height &&
              preview.y + preview.height > actual.y;
            expect(overlaps).toBe(false);
          }
        }
        await page.keyboard.press("Escape");
        await expect(mark).toHaveAttribute("aria-grabbed", "false");
        await expect(page.locator("body")).not.toHaveClass(
          /is-boundary-dragging/,
        );
        await expect(page.locator(".transcript-list")).not.toHaveClass(
          /is-boundary-dragging/,
        );
        await expect(page.locator(".edit-boundary-preview")).toHaveCount(0);
        await page.mouse.up();
      });
    }
  }
}

test("long commit failure stays readable in a short phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 360 });
  await page.goto(
    "/iframe.html?id=templates-editboundarymark--long-failure&viewMode=story&globals=theme:light",
  );
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Detailed server failure");
  const preview = page.locator(".edit-boundary-preview");
  const box = await preview.boundingBox();
  if (!box) throw new Error("Failure preview has no rendered rectangle");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(360);
  const scroll = await alert.evaluate((element) => ({
    content: element.scrollHeight,
    visible: element.clientHeight,
  }));
  expect(scroll.content).toBeGreaterThan(scroll.visible);
  const dismiss = page.getByRole("button", { name: "Dismiss boundary error" });
  await expect(dismiss).toBeVisible();
  await dismiss.focus();
  await expect(dismiss).toBeFocused();
  await dismiss.click();
  await expect(alert).toHaveCount(0);
  await expect(page.locator("button[data-boundary-id]")).toBeFocused();
});

test("Tab away cancels the gesture before Escape or pointer release", async ({
  page,
}) => {
  await page.goto(
    "/iframe.html?id=templates-editboundarymark--roll-join&viewMode=story&globals=theme:light",
  );
  const mark = page.locator("button[data-boundary-id]");
  await expect(mark).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const box = await mark.boundingBox();
  if (!box) throw new Error("Boundary has no rendered rectangle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y);
  await expect(mark).toHaveAttribute("aria-grabbed", "true");
  await page.keyboard.press("Tab");
  await expect(mark).toHaveAttribute("aria-grabbed", "false");
  await expect(page.locator("body")).not.toHaveClass(/is-boundary-dragging/);
  await expect(page.locator(".transcript-list")).not.toHaveClass(
    /is-boundary-dragging/,
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(mark).toHaveAttribute("aria-grabbed", "false");
  await expect(page.locator(".edit-boundary-preview")).toHaveCount(0);
});
