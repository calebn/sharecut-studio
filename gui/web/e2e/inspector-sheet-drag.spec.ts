import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { newFinger } from "./finger";
import { openProject, phone } from "./stageNav";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  reducedMotion: "reduce",
});

test("a finger drags the phone Inspector sheet through its detents and off the screen", async ({
  page,
  context,
  browserName,
}) => {
  await openProject(page, e2eProjectPath);
  await phone.showTimeline(page);
  const header = page.locator(".sys-track-main").first();
  await header.tap();

  const sheet = page.getByRole("dialog", { name: "Inspector", exact: true });
  await expect(sheet).toBeVisible();
  const grip = sheet.getByRole("slider", { name: "Sheet height" });
  await expect(grip).toHaveAttribute("aria-valuetext", "Half height");
  const finger = await newFinger(context, page, browserName);
  const height = async () => (await sheet.boundingBox())!.height;
  const center = async () => {
    const box = (await grip.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  await page.evaluate(() => {
    const w = window as unknown as { lastMove: number };
    w.lastMove = 0;
    addEventListener(
      "pointermove",
      () => (w.lastMove = performance.now()),
      true,
    );
  });
  const drag = async (dy: number) => {
    const from = await center();
    await finger.down(from);
    await finger.slide({ x: from.x, y: from.y + dy }, 12, 30);
    // Lifting straight after a move reads as a flick; let the finger rest first.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            performance.now() -
            (window as unknown as { lastMove: number }).lastMove,
        ),
      )
      .toBeGreaterThan(150);
    await finger.up();
  };

  const half = await height();
  await drag(-300);
  await expect(grip).toHaveAttribute("aria-valuetext", "Full height");
  const full = await height();
  expect(full).toBeGreaterThan(half + 100);

  await drag(300);
  await expect(grip).toHaveAttribute("aria-valuetext", "Half height");
  expect(Math.abs((await height()) - half)).toBeLessThan(4);

  await drag(Math.round(half * 0.75));
  await expect(grip).toHaveAttribute("aria-valuetext", "Dock");
  expect(await height()).toBeLessThan(half / 2);

  await drag(200);
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".sys-track[data-selected]")).toHaveCount(0);
  await expect(header).toBeFocused();
});

test.describe("a phone held sideways", () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test("a 667x375 phone shell gets the Inspector sheet and no column", async ({
    page,
  }) => {
    await openProject(page, e2eProjectPath);
    await phone.showTimeline(page);
    const header = page.locator(".sys-track-main").first();
    await header.focus();
    await header.press("Enter");
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(page.locator(".sys-inspector--phone")).toBeVisible();
    await expect(page.locator(".bottom-sheet--column")).toHaveCount(0);
  });
});
