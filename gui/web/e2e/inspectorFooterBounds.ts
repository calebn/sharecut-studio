import { expect, type Locator } from "@playwright/test";

export async function expectPreviewFooterTouchBounds(inspector: Locator) {
  const footer = inspector.locator(".modifier-footer");
  const actions = footer.locator(".modifier-footer-actions");
  const preview = actions.getByRole("group", { name: "Preview mode" });
  const buttons = actions.getByRole("button");
  await expect(footer).toBeVisible();
  await expect(buttons).toHaveText([
    "Seek",
    "Play around",
    "Current",
    "Suggested",
    "A/B",
  ]);
  await expect(preview.getByRole("button")).toHaveCount(3);
  await inspector.page().evaluate(() => document.fonts.ready);
  // Opened by Inspect, the card is still settling; measure once it has stopped.
  let settled = "";
  await expect
    .poll(async () => {
      const last = settled;
      const box = await footer.boundingBox();
      const actionsNow = await actions.boundingBox();
      settled = JSON.stringify([box, actionsNow]);
      return settled === last;
    })
    .toBe(true);

  const footerBox = (await footer.boundingBox())!;
  const actionsBox = (await actions.boundingBox())!;
  const previewBox = (await preview.boundingBox())!;
  const pairs = [
    { parent: footerBox, child: actionsBox, label: "footer contains actions" },
    { parent: actionsBox, child: previewBox, label: "actions contain preview" },
  ];
  for (const button of await buttons.all()) {
    const box = (await button.boundingBox())!;
    const label = await button.innerText();
    expect(box.width, label).toBeGreaterThanOrEqual(44);
    expect(box.height, label).toBeGreaterThanOrEqual(44);
    pairs.push({ parent: actionsBox, child: box, label });
  }
  for (const button of await preview.getByRole("button").all()) {
    pairs.push({
      parent: previewBox,
      child: (await button.boundingBox())!,
      label: `preview contains ${await button.innerText()}`,
    });
  }
  for (const { parent, child, label } of pairs) {
    expect(child.x - parent.x, label).toBeGreaterThanOrEqual(-0.5);
    expect(child.y - parent.y, label).toBeGreaterThanOrEqual(-0.5);
    expect(
      parent.x + parent.width - child.x - child.width,
      label,
    ).toBeGreaterThanOrEqual(-0.5);
    expect(
      parent.y + parent.height - child.y - child.height,
      label,
    ).toBeGreaterThanOrEqual(-0.5);
  }
}
