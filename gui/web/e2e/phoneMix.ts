import { expect, type Page, type TestInfo } from "@playwright/test";
import type { ProjectView } from "../src/types/project";
import { isApplePlatform } from "../src/utils/platform";
import { expectPageAxeClean } from "./axe";

export async function openPhoneMix(page: Page) {
  const nav = page.getByRole("navigation", { name: "Primary" });
  await nav.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("button", { name: "Mix", exact: true }).click();
  const mix = page.getByRole("dialog", { name: "Mix", exact: true });
  await expect(mix).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(mix.getByRole("button", { name: "Close" })).toBeFocused();
  await mix.evaluate(async (el) => {
    await Promise.all(
      el.getAnimations().map((animation) => animation.finished),
    );
  });
  return mix;
}

export async function savedMix(page: Page, projectPath: string) {
  const response = await page.request.get(
    `/api/project?phase=full&path=${encodeURIComponent(projectPath)}`,
  );
  expect(response.ok()).toBe(true);
  const snapshot = (await response.json()) as ProjectView;
  return snapshot.tracks.map((track) => ({
    id: track.id,
    label: track.label || track.id,
    db: track.fader_db ?? 0,
    muted: Boolean(track.muted),
  }));
}

export async function checkMixGeometry(page: Page, info: TestInfo) {
  const mix = page.getByRole("dialog", { name: "Mix", exact: true });
  const geometry = await mix.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const nav = document.querySelector(".mobile-nav")?.getBoundingClientRect();
    const rows = [...el.querySelectorAll(".track-mix-row")].map(
      (row) => row.getBoundingClientRect().height,
    );
    const targets = [
      ...el.querySelectorAll(
        ".track-mix button,.track-mix input,.dialog-close",
      ),
    ].map((control) => {
      const box = control.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    return {
      sheetBottom: rect.bottom,
      navTop: nav?.top,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      mixWidth: el.clientWidth,
      mixScrollWidth: el.scrollWidth,
      rows,
      targets,
    };
  });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.mixScrollWidth).toBeLessThanOrEqual(geometry.mixWidth);
  expect(geometry.sheetBottom).toBeLessThanOrEqual((geometry.navTop ?? 0) + 1);
  expect(geometry.rows.every((height) => height >= 56)).toBe(true);
  for (const target of geometry.targets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
  const last = mix.getByRole("listitem").last();
  await last.scrollIntoViewIfNeeded();
  const body = await page.locator(".bottom-sheet-body").boundingBox();
  const row = await last.boundingBox();
  expect(row!.y + row!.height).toBeLessThanOrEqual(body!.y + body!.height + 1);
  await expectPageAxeClean(page);
  await info.attach("mix-geometry", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("mix.png") });
}

export async function checkNativeMixEdits(page: Page, projectPath: string) {
  const mix = await openPhoneMix(page);
  const before = await savedMix(page, projectPath);
  const first = before[0];
  const slider = mix.getByRole("slider", {
    name: `Volume ${first.label}`,
    exact: true,
  });
  const expectedKeyboardDb = Math.min(12, first.db + 0.5);
  await slider.focus();
  await slider.press("ArrowRight");
  await expect(slider).toHaveValue(String(expectedKeyboardDb));
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].db)
    .toBe(expectedKeyboardDb);
  const box = await slider.boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width * 0.4,
    box!.y + box!.height * 0.65,
    { steps: 4 },
  );
  const draft = Number(await slider.inputValue());
  expect(draft).not.toBe(expectedKeyboardDb);
  expect((await savedMix(page, projectPath))[0].db).toBe(expectedKeyboardDb);
  await page.mouse.up();
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].db)
    .toBe(draft);
  await mix
    .getByRole("button", { name: `Mute ${first.label}`, exact: true })
    .click();
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].muted)
    .toBe(!first.muted);
  const saved = await savedMix(page, projectPath);
  await mix
    .getByRole("button", { name: `Solo ${first.label}`, exact: true })
    .click();
  await expect(
    mix.getByRole("button", { name: `Solo ${first.label}`, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await savedMix(page, projectPath)).toEqual(saved);
  await page.reload();
  await expect(page.locator(".daw-shell--phone")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Mix", exact: true }),
  ).toHaveCount(0);
  const reloaded = await openPhoneMix(page);
  await expect(
    reloaded.getByRole("slider", {
      name: `Volume ${first.label}`,
      exact: true,
    }),
  ).toHaveValue(String(draft));
  await expect(
    reloaded.getByRole("button", { name: `Mute ${first.label}`, exact: true }),
  ).toHaveAttribute("data-mute-state", "saved");
  await reloaded.getByRole("button", { name: "Close" }).click();
  await expect(
    page.getByRole("button", { name: "Mix", exact: true }),
  ).toBeFocused();
  const undo = (await page.evaluate(isApplePlatform)) ? "Meta+z" : "Control+z";
  await page.keyboard.press(undo);
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].muted)
    .toBe(first.muted);
  await page.keyboard.press(undo);
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].db)
    .toBe(expectedKeyboardDb);
  await page.keyboard.press(undo);
  await expect
    .poll(async () => (await savedMix(page, projectPath))[0].db)
    .toBe(first.db);
}
