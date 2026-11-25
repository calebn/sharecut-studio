import { expect, type Locator } from "@playwright/test";

const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error("no box");
  return found;
};

export const detentOf = (sheet: Locator) =>
  sheet.evaluate(
    (element) =>
      /bottom-sheet--(peek|half|full)/.exec(element.className)?.[1] ?? "",
  );

export async function expectActionsPinned(
  sheet: Locator,
  names: readonly [string, string],
) {
  const panel = await box(sheet);
  const footer = sheet.locator(".sys-sheet-footer");
  await expect(footer).toHaveCount(1);
  for (const name of names) {
    const button = footer.getByRole("button", { name, exact: true });
    await expect(button).toBeInViewport({ ratio: 1 });
    const rect = await box(button);
    expect(rect.y).toBeGreaterThanOrEqual(panel.y - 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(
      panel.y + panel.height + 1,
    );
    expect(rect.height).toBeGreaterThanOrEqual(47);
  }
}

/** Short-in-rem screens (large text on a small phone): a pinned footer would starve the form. */
export async function expectActionsInBody(
  sheet: Locator,
  names: readonly [string, string],
) {
  await expect(sheet.locator(".sys-sheet-footer")).toHaveCount(0);
  for (const name of names) {
    const button = sheet
      .locator(".sys-sheet-scroll")
      .getByRole("button", { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 0.5 });
    const panel = await box(sheet);
    const rect = await box(button);
    expect(rect.y + rect.height / 2).toBeLessThanOrEqual(
      panel.y + panel.height,
    );
  }
}

export async function expectResizes(
  sheet: Locator,
  names: readonly [string, string],
  where: "footer" | "body" = "footer",
) {
  const reached = () =>
    where === "footer"
      ? expectActionsPinned(sheet, names)
      : expectActionsInBody(sheet, names);
  const slider = sheet.getByRole("slider", { name: "Sheet height" });
  const start = await detentOf(sheet);
  const settle = async (want: string) => {
    await expect.poll(() => detentOf(sheet)).toBe(want);
    await sheet.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations({ subtree: true }).map((a) => a.finished),
      );
    });
  };
  if (start === "half") {
    await expect(slider).toHaveAttribute("aria-valuetext", "Half height");
    const before = await box(sheet);
    await sheet
      .getByRole("button", { name: "Expand to full height", exact: true })
      .tap();
    await settle("full");
    await expect(slider).toHaveAttribute("aria-valuetext", "Full height");
    const full = await box(sheet);
    if (where === "footer")
      expect(full.height).toBeGreaterThan(before.height + 20);
    await reached();
  }
  await sheet
    .getByRole("button", { name: "Collapse to strip", exact: true })
    .tap();
  await settle("peek");
  const strip = await box(sheet);
  await sheet
    .getByRole("button", { name: "Expand to half height", exact: true })
    .tap();
  await settle("half");
  // The slot is already as small as the strip in the cramped cell, so only the state changes.
  if (where === "footer")
    expect((await box(sheet)).height).toBeGreaterThan(strip.height + 20);
  await slider.focus();
  await slider.press("End");
  await settle("full");
  await slider.press("Home");
  await settle("peek");
  await slider.press("ArrowRight");
  await settle("half");
}
