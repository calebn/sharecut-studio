import { expect, test } from "@playwright/test";
import { expectShellFit, openStory } from "./shellFit";
import { storyUrl } from "./storyUrl";

const PHONE_STORIES = [
  "shell--phone-listen",
  "shell--phone-timeline",
  "shell--phone-text",
  "shell--phone-more",
  "shell--phone-comments",
  "shell--phone-guest",
] as const;

for (const id of PHONE_STORIES) {
  test(`${id} keeps Primary navigation on screen at 360`, async ({ page }) => {
    await openStory(page, id, 360, "light");
    await expectShellFit(page, 360);
    const nav = await page
      .getByRole("navigation", { name: "Primary" })
      .boundingBox();
    if (!nav) throw new Error("Primary navigation has no rectangle");
    expect(nav.y + nav.height).toBeLessThanOrEqual(900);
  });
}

test("the wide transport bar opens View with the layer toggles", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(
    storyUrl("templates-transport-menus--wide-bar", { theme: "light" }),
  );
  await page.getByRole("button", { name: "View", exact: true }).click();
  const menu = page.getByRole("menu", { name: "View" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Layers")).toBeVisible();
});

const LAYOUTS = [
  { id: "shell--layout-timeline", mode: "timeline", transcript: false },
  { id: "shell--layout-text", mode: "text", transcript: true },
  { id: "shell--layout-review", mode: "review", transcript: true },
] as const;

for (const { id, mode, transcript } of LAYOUTS) {
  test(`${mode} layout shows the Restore chip and the right panes`, async ({
    page,
  }) => {
    await openStory(page, id, 1280, "light");
    await expect(page.locator(`.daw-shell--layout-${mode}`)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Restore layout" }),
    ).toBeVisible();
    const panel = page.locator(".transcript-panel");
    if (transcript) await expect(panel).toBeVisible();
    else
      await expect(
        page.getByRole("button", { name: "Show editor panels" }),
      ).toBeVisible();
  });
}
