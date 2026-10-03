import { expect, test } from "@playwright/test";

test("manager Docs toolbar themes reach isolated previews and follow System", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(
    "/?path=/docs/templates-joinpopover--docs&globals=theme:light",
  );
  const docs = page.frameLocator("#storybook-preview-iframe");
  const iframe = docs.locator("#story--templates-joinpopover--fade iframe");
  await iframe.scrollIntoViewIfNeeded();
  const story = docs.frameLocator("#story--templates-joinpopover--fade iframe");
  await expect(story.locator(".join-popover")).toBeVisible();

  for (const root of [docs.locator("html"), story.locator("html")]) {
    await expect(root).toHaveAttribute("data-theme", "light");
    await expect(root).toHaveCSS("color-scheme", "light");
  }

  const toolbar = page.getByRole("button", {
    name: /Light \/ dark \/ system Studio theme/,
  });
  await toolbar.click();
  await page.getByText("Dark", { exact: true }).last().click();
  await expect(story.locator(".join-popover")).toBeVisible();
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await expect(root).toHaveAttribute("data-theme", "dark");
    await expect(root).toHaveCSS("color-scheme", "dark");
  }

  await toolbar.click();
  await page.getByText("System", { exact: true }).last().click();
  await expect(story.locator(".join-popover")).toBeVisible();
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await expect(root).not.toHaveAttribute("data-theme");
    await expect(root).toHaveCSS("color-scheme", "dark");
  }

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await expect(root).not.toHaveAttribute("data-theme");
    await expect(root).toHaveCSS("color-scheme", "light");
  }
});
