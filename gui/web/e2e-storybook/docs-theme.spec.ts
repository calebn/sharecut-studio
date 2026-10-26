import { expect, test } from "@playwright/test";

// The manager boots a docs preview that boots a nested story preview. Under
// four busy workers that takes longer than the 5 s default, on main as well.
const slowExpect = expect.configure({ timeout: 20_000 });

test("manager Docs toolbar themes reach isolated previews and follow System", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto(
    "/?path=/docs/templates-joinpopover--docs&globals=theme:light",
  );
  const docs = page.frameLocator("#storybook-preview-iframe");
  const iframe = docs.locator("#story--templates-joinpopover--fade iframe");
  await iframe.scrollIntoViewIfNeeded();
  const story = docs.frameLocator("#story--templates-joinpopover--fade iframe");
  await slowExpect(story.locator(".command-palette-panel")).toBeVisible();

  for (const root of [docs.locator("html"), story.locator("html")]) {
    await slowExpect(root).toHaveAttribute("data-theme", "light");
    await slowExpect(root).toHaveCSS("color-scheme", "light");
  }

  const toolbar = page.getByRole("button", {
    name: /Light \/ dark \/ system Studio theme/,
  });
  await toolbar.click();
  await page.getByText("Dark", { exact: true }).last().click();
  await slowExpect(story.locator(".command-palette-panel")).toBeVisible();
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await slowExpect(root).toHaveAttribute("data-theme", "dark");
    await slowExpect(root).toHaveCSS("color-scheme", "dark");
  }

  await toolbar.click();
  await page.getByText("System", { exact: true }).last().click();
  await slowExpect(story.locator(".command-palette-panel")).toBeVisible();
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await slowExpect(root).not.toHaveAttribute("data-theme");
    await slowExpect(root).toHaveCSS("color-scheme", "dark");
  }

  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  for (const root of [docs.locator("html"), story.locator("html")]) {
    await slowExpect(root).not.toHaveAttribute("data-theme");
    await slowExpect(root).toHaveCSS("color-scheme", "light");
  }
});
