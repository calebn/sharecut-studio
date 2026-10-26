import { expect, type Page } from "@playwright/test";

export async function expectShellFit(page: Page, width: number) {
  const geometry = await page.locator(".stage-frame").evaluate((shell) => {
    const main = shell.querySelector("main");
    if (!main) throw new Error("Frame has no main region");
    const rect = shell.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      height: rect.height,
      bodyHeight: main.getBoundingClientRect().height,
      documentWidth: document.documentElement.scrollWidth,
      shellWidth: shell.clientWidth,
      scrollWidth: shell.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(width);
  expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.shellWidth);
  expect(geometry.height).toBe(900);
  expect(geometry.bodyHeight).toBeGreaterThan(200);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
}

export async function expectRootFit(page: Page, width: number) {
  const box = await page.locator("#storybook-root").evaluate((root) => {
    const rect = root.getBoundingClientRect();
    return { left: rect.left, right: rect.right, height: rect.height };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(width);
  expect(box.height).toBeGreaterThan(0);
}
