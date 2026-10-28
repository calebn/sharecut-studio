import { devices, expect, test } from "@playwright/test";
import { storyUrl } from "./storyUrl";

// Pixel 5 emulation gives the coarse pointer that `--touch-min` is gated on.
test.use({ ...devices["Pixel 5"] });

/**
 * The touch range-arm toggle lives in the Edit corner (#2294). jsdom has no
 * CSS, so the 44px target and the hit-test are measured here in real layout.
 */
test("Stages/Edit/Corner range toggle is a 44px target on a phone", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(
    storyUrl("stages-edit-corner--touch-with-range", { theme: "light" }),
  );
  const toggle = page.getByRole("button", { name: "Select range" });
  await expect(toggle).toBeVisible();
  const box = await toggle.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  if (!box) return;
  // Every corner and the centre of the box must land on the toggle itself.
  const inset = 1;
  const points = [
    [box.x + inset, box.y + inset],
    [box.x + box.width - inset, box.y + inset],
    [box.x + inset, box.y + box.height - inset],
    [box.x + box.width - inset, box.y + box.height - inset],
    [box.x + box.width / 2, box.y + box.height / 2],
  ];
  for (const [x, y] of points) {
    const hit = await page.evaluate(
      ([px, py]) =>
        document
          .elementFromPoint(px, py)
          ?.closest("button")
          ?.getAttribute("aria-label") ?? null,
      [x, y],
    );
    expect(hit).toBe("Select range");
  }
});
