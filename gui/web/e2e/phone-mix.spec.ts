import { expect, test } from "@playwright/test";
import { postDocumentCommand } from "./documentCommand";
import {
  checkMixGeometry,
  checkNativeMixEdits,
  openPhoneMix,
  savedMix,
} from "./phoneMix";
import { withShareableProject } from "./shareableProject";
import { createReviewShare } from "./shareNavigation";

for (const theme of ["light", "dark"]) {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 740 },
    { width: 360, height: 900 },
  ]) {
    test(`phone Mix fits ${viewport.width}x${viewport.height} in ${theme}`, async ({
      page,
    }, info) => {
      await page.setViewportSize(viewport);
      await withShareableProject(async (projectPath) => {
        await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
        await expect(page.locator(".daw-shell--phone")).toBeVisible();
        for (let i = 0; i < 8; i++)
          await postDocumentCommand(
            page,
            "mix-geometry",
            "AddTrack",
            { label: `Extra voice ${i + 1} with a long recording name` },
            projectPath,
          );
        await page.evaluate((theme) => {
          localStorage.setItem("daw_theme", theme);
          document.documentElement.setAttribute("data-theme", theme);
        }, theme);
        await openPhoneMix(page);
        await checkMixGeometry(page, info);
        await page
          .getByRole("dialog", { name: "Mix", exact: true })
          .getByRole("button", { name: "Close" })
          .click();
        await expect(
          page.getByRole("button", { name: "Mix", exact: true }),
        ).toBeFocused();
        await openPhoneMix(page);
        await page.keyboard.press("Escape");
        await expect(
          page.getByRole("button", { name: "Mix", exact: true }),
        ).toBeFocused();
      });
    });
  }
}
test("phone Mix persists native edits, keeps S private and undoes saved changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await checkNativeMixEdits(page, projectPath);
  });
});
test("viewer Mix keeps M/S private and cannot override saved mute", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const token = await createReviewShare(page, projectPath);
    const before = await savedMix(page, projectPath);
    await postDocumentCommand(
      page,
      "mix-readonly",
      "SetTrackMute",
      { track_id: before[1].id, muted: true },
      projectPath,
    );
    await page.goto(`/r/${token}`);
    await expect(page.locator(".daw-shell--phone")).toBeVisible();
    const mix = await openPhoneMix(page);
    const persisted = await savedMix(page, projectPath);
    await expect(mix.getByRole("slider").first()).toBeDisabled();
    await expect(mix.getByRole("slider").first()).toHaveAccessibleDescription(
      /Only the host and editors can change volume/,
    );
    await expect(mix.getByText(/Shared playback uses Full mix/)).toBeVisible();
    await mix
      .getByRole("button", { name: `Mute ${before[0].label}`, exact: true })
      .click();
    await expect(
      mix.getByRole("button", { name: `Mute ${before[0].label}`, exact: true }),
    ).toHaveAttribute("data-mute-state", "listen");
    await mix
      .getByRole("button", { name: `Solo ${before[0].label}`, exact: true })
      .click();
    await expect(
      mix.getByRole("button", { name: `Mute ${before[1].label}`, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
    await mix
      .getByRole("button", { name: `Mute ${before[1].label}`, exact: true })
      .press("Enter");
    expect(await savedMix(page, projectPath)).toEqual(persisted);
  });
});

test("editor Mix commits saved volume through guest capabilities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    const token = await createReviewShare(page, projectPath, "editor");
    const before = await savedMix(page, projectPath);
    await page.goto(`/r/${token}`);
    const mix = await openPhoneMix(page);
    const slider = mix.getByRole("slider", {
      name: `Volume ${before[0].label}`,
      exact: true,
    });
    await expect(slider).toBeEnabled();
    await slider.focus();
    await slider.press("ArrowRight");
    await expect
      .poll(async () => (await savedMix(page, projectPath))[0].db)
      .toBe(before[0].db + 0.5);
    await mix
      .getByRole("button", { name: `Mute ${before[0].label}`, exact: true })
      .click();
    await expect
      .poll(async () => (await savedMix(page, projectPath))[0].muted)
      .toBe(!before[0].muted);
  });
});

test("phone Mix restores Escape focus after Tab and yields to the Bounce shortcut", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
    await openPhoneMix(page);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Text", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("dialog", { name: "Mix", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toBeFocused();
    await openPhoneMix(page);
    await page.keyboard.press("Control+Shift+B");
    const bounce = page.getByRole("dialog", { name: "Bounce…", exact: true });
    await expect(bounce).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(
      bounce.getByRole("button", { name: "Close", exact: true }),
    ).toBeFocused();
    await bounce.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toBeVisible();
  });
});
