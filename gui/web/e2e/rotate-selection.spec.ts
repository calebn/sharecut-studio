import { expect, type Page, test } from "@playwright/test";
import { openHostProject } from "./overlayReachability";
import { phone } from "./stageNav";
import { openTranscriptPanel } from "./transcriptEdit";

/*
 * Rotating a landscape tablet to portrait swaps in the phone shell, which used to open on
 * Listen and hide the selected clip behind its Inspector sheet (#1767).
 */

test("a selected clip stays on the Timeline screen when a tablet is rotated to portrait", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openHostProject(page);
  const clip = page.locator(".clip-block").first();
  await clip.click();
  await expect(page.locator(".clip-block.selected").first()).toBeVisible();

  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(page.locator(".stage-frame")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(
    page
      .getByRole("group", { name: "Edit surface" })
      .getByRole("button", { name: "Timeline", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".clip-block.selected").first()).toBeVisible();
});

test("a phone with nothing selected opens on Edit with the Timeline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHostProject(page);
  await expect(page.locator(".stage-frame--phone")).toBeVisible();
  await expect(page.getByRole("main", { name: "Edit" })).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Edit surface" })
      .getByRole("button", { name: "Timeline", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

async function doubleTapFirstWord(page: Page) {
  const word = page
    .locator('[data-transcript-word][data-word-index="0"]')
    .first();
  await expect(word).toBeVisible();
  const box = await word.boundingBox();
  expect(box).toBeTruthy();
  const point = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
    id: 1,
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  for (let tap = 0; tap < 2; tap += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [point],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  return word;
}

test.describe("rotating with the word editor open (#1870)", () => {
  test.use({ hasTouch: true });

  const rotations = [
    { name: "phone portrait to landscape", from: [390, 844], to: [844, 390] },
    {
      name: "tablet landscape to portrait (same shell)",
      from: [1194, 834],
      to: [834, 1194],
    },
    { name: "tablet landscape to phone", from: [1194, 834], to: [390, 844] },
  ] as const;

  for (const { name, from, to } of rotations) {
    test(`${name} keeps Correct, the sheet and the word`, async ({ page }) => {
      await page.setViewportSize({ width: from[0], height: from[1] });
      await openHostProject(page);
      if (from[0] < 768) {
        await phone.showText(page);
      } else {
        await openTranscriptPanel(page);
      }
      const word = await doubleTapFirstWord(page);
      await expect(word).toHaveClass(/selected/);
      await expect(page.getByLabel("Corrected text")).toBeVisible();

      await page.setViewportSize({ width: to[0], height: to[1] });
      // The phone shows one Edit surface at a time and opens on the Timeline.
      if (from[0] >= 768 && to[0] < 768) await phone.showText(page);

      const rotated = page
        .locator('[data-transcript-word][data-word-index="0"]')
        .first();
      await expect(rotated).toHaveClass(/selected/);
      // The tablet's card hides while its word is out of view; bring it back.
      await rotated.scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Corrected text")).toBeVisible();
      await expect(page.locator("[data-transcript-intent]")).toHaveAttribute(
        "data-transcript-intent",
        "correct",
      );
    });
  }
});
