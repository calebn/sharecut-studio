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
import { openProject, openProjectDialog } from "./stageNav";
import { withAppearance } from "./theme";

for (const { cell: viewport, theme } of withAppearance([
  { width: 320, height: 640 },
  { width: 360, height: 740 },
  { width: 360, height: 900 },
])) {
  test(`phone Mix fits ${viewport.width}x${viewport.height} in ${theme}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await withShareableProject(async (projectPath) => {
      await openProject(page, projectPath);
      await expect(page.locator(".stage-frame--phone")).toBeVisible();
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
      await checkMixGeometry(page, info, { suite: "main" });
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
test("phone Mix persists native edits, keeps S private and undoes saved changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    await checkNativeMixEdits(page, projectPath);
  });
});
/**
 * The stage shell gives a Viewer link the Review stage only, so its Mix has no
 * sheet to open: the sliders the old case found disabled are not there at all.
 * The guarantee that stays is the one the case existed for: a viewer neither
 * changes the saved mix nor gets a way to.
 */
test("viewer link has no Mix sheet and cannot override saved mute", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
    const token = await createReviewShare(page, projectPath);
    const before = await savedMix(page, projectPath);
    await postDocumentCommand(
      page,
      "mix-readonly",
      "SetTrackMute",
      { track_id: before[1].id, muted: true },
      projectPath,
    );
    const persisted = await savedMix(page, projectPath);
    expect(persisted[1].muted).toBe(true);

    const posted: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/document\/command/.test(request.url())
      )
        posted.push(request.url());
    });
    await page.goto(`/r/${token}`);
    await expect(page.locator(".stage-frame--phone")).toBeVisible();
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Stages" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toHaveCount(0);

    // The palette lists Go to Edit, and the link refuses it.
    await openProjectDialog(page, "palette");
    const search = page.getByRole("combobox", { name: "Search commands" });
    await search.fill("Go to Edit");
    await search.press("Enter");
    await expect(page.getByRole("main", { name: "Review" })).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Mix", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Mix", exact: true }),
    ).toHaveCount(0);

    expect(posted).toEqual([]);
    expect(await savedMix(page, projectPath)).toEqual(persisted);
  });
});

test("editor Mix commits saved volume through guest capabilities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await withShareableProject(async (projectPath) => {
    await openProject(page, projectPath);
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
    await openProject(page, projectPath);
    await openPhoneMix(page);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("Shift+Tab");
    }
    await expect(
      page
        .getByRole("tablist", { name: "Stages" })
        .getByRole("tab", { name: /^Edit\b/ }),
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
