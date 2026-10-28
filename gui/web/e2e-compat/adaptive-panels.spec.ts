import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { e2eProjectPath, repoRoot } from "../e2e/env";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import { hostOfflineQueueCount } from "../e2e/offlineQueue";
import { switchE2eProject } from "../e2e/shareableProject";
import {
  closeTools,
  openProject,
  openToolsIfFolded,
  saveStatus,
} from "../e2e/stageNav";
import { setTheme, withAppearance } from "../e2e/theme";

test.use({ hasTouch: true, isMobile: true });

function isMuteRequest(
  request: Request,
  projectPath: string,
  trackId: string,
  muted: boolean,
) {
  const url = new URL(request.url());
  if (
    request.method() !== "POST" ||
    url.pathname !== "/api/document/command" ||
    url.searchParams.get("path") !== projectPath
  )
    return false;
  const command = request.postDataJSON();
  return (
    command.type === "SetTrackMute" &&
    command.payload.track_id === trackId &&
    command.payload.muted === muted
  );
}

function muteAcknowledgment(
  page: Page,
  projectPath: string,
  trackId: string,
  muted: boolean,
) {
  return page.waitForResponse((response) =>
    isMuteRequest(response.request(), projectPath, trackId, muted),
  );
}

async function expectMixSettled(page: Page, projectPath: string) {
  await expect.poll(() => hostOfflineQueueCount(page, projectPath)).toBe(0);
  await expect(saveStatus(page)).toHaveText("Saved");
  await expect(
    page.getByRole("region", { name: /Needs attention/ }),
  ).toBeHidden();
}

async function expectTouchable(page: Page, control: Locator) {
  const bounds = await control.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  const scrollport = await page.locator(".timeline-scroll").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(scrollport!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    scrollport!.y + scrollport!.height,
  );
  expect(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2,
        ),
      );
    }),
  ).toBe(true);
}

for (const { theme, reducedMotion } of withAppearance([0, 1])) {
  test.describe(`${theme}`, () => {
    test("fresh short landscape exposes both tracks and keeps their Mute and Solo reachable", async ({
      page,
    }) => {
      const fixture = createRelocatedE2eProject(
        "sharecut-e2e-adaptive-panels-",
        undefined,
        path.join(repoRoot, "tests/fixtures/sharecut_ux_demo"),
      );
      try {
        await switchE2eProject(fixture.projectPath);
        await page.setViewportSize({ width: 844, height: 390 });
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem("daw_theme", selectedTheme);
          localStorage.setItem("sharecut.homeScreenHintDismissed", "1");
        }, theme);
        await openProject(page, fixture.projectPath);
        await setTheme(page, theme);
        await expect(page.locator(".stage-frame--tablet")).toBeVisible();
        await expect(page.locator(".track-header-row")).toHaveCount(2);
        // The stacked tablet gives the lower half to the Script; the timeline
        // takes the whole body once the Script is hidden.
        const folded = await openToolsIfFolded(page);
        await page.getByRole("button", { name: "Show or hide Script" }).click();
        if (folded) await closeTools(page);
        await expect(page.locator(".edit-script")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        const scroller = page.locator(".timeline-scroll");
        await expect(scroller).toHaveJSProperty("scrollTop", 0);
        for (const track of ["reference", "guest"]) {
          const identity = page
            .locator(".clip-label")
            .filter({ hasText: new RegExp(`^${track} ·`) })
            .first();
          await expect(identity).toBeVisible();
          expect(
            await identity.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
          const identityBox = await identity.boundingBox();
          const timelineBox = await scroller.boundingBox();
          expect(identityBox!.y).toBeGreaterThanOrEqual(timelineBox!.y);
          expect(identityBox!.y + identityBox!.height).toBeLessThanOrEqual(
            timelineBox!.y + timelineBox!.height,
          );
          for (const action of ["Mute", "Solo"]) {
            const button = page.getByRole("button", {
              name: `${action} ${track}`,
              exact: true,
            });
            for (const pressed of [true, false]) {
              await expectTouchable(page, button);
              const acknowledgment =
                action === "Mute"
                  ? muteAcknowledgment(
                      page,
                      fixture.projectPath,
                      track,
                      pressed,
                    )
                  : null;
              await button.tap();
              await expect(button).toHaveAttribute(
                "aria-pressed",
                String(pressed),
              );
              if (acknowledgment) {
                expect((await acknowledgment).ok()).toBe(true);
                await expectMixSettled(page, fixture.projectPath);
              }
              await expect(scroller).toHaveJSProperty("scrollTop", 0);
            }
          }
        }
      } finally {
        await switchE2eProject(e2eProjectPath);
        removeRelocatedE2eProject(fixture.workspaceDir);
      }
    });
  });
}

for (const { cell: rootPx, theme, reducedMotion } of withAppearance([16, 32])) {
  test.describe(`root${rootPx} ${theme}`, () => {
    test("the corner controls leave their targets clear", async ({ page }) => {
      const fixture = createRelocatedE2eProject(
        "sharecut-e2e-adaptive-rail-",
        undefined,
        path.join(repoRoot, "tests/fixtures/sharecut_ux_demo"),
      );
      try {
        await switchE2eProject(fixture.projectPath);
        await page.setViewportSize({ width: 844, height: 390 });
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await page.addInitScript(() =>
          localStorage.setItem("sharecut.homeScreenHintDismissed", "1"),
        );
        await openProject(page, fixture.projectPath);
        await setTheme(page, theme);
        await expect(page.locator(".track-header-row")).toHaveCount(2);
        await page.evaluate(() => document.fonts.ready);
        await page.locator("html").evaluate((html, size) => {
          html.style.fontSize = `${size}px`;
        }, rootPx);
        const controls = page.locator(
          '[role="group"][aria-label="Timeline view"] button',
        );
        let visible = 0;
        for (const control of await controls.all()) {
          if (!(await control.isVisible())) continue;
          visible++;
          const probe = await control.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const covering = new Set<string>();
            for (const x of [0.1, 0.5, 0.9])
              for (const y of [0.1, 0.5, 0.9]) {
                const hit = document.elementFromPoint(
                  box.x + box.width * x,
                  box.y + box.height * y,
                );
                if (!element.contains(hit))
                  covering.add(`${hit?.tagName}.${hit?.className}`);
              }
            return {
              label: element.getAttribute("aria-label"),
              box: [box.x, box.y, box.width, box.height],
              covering: [...covering],
            };
          });
          expect(probe.covering, JSON.stringify(probe)).toEqual([]);
        }
        expect(visible).toBeGreaterThan(1);
      } finally {
        await switchE2eProject(e2eProjectPath);
        removeRelocatedE2eProject(fixture.workspaceDir);
      }
    });
  });
}

for (const { theme, reducedMotion } of withAppearance([0], 3)) {
  test.describe(`${theme}`, () => {
    test("a native guest Mute center tap stays at scrollTop zero while acknowledgment is pending", async ({
      page,
    }) => {
      const fixture = createRelocatedE2eProject(
        "sharecut-e2e-adaptive-pending-",
        undefined,
        path.join(repoRoot, "tests/fixtures/sharecut_ux_demo"),
      );
      let releaseResponse!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let responseHeld!: () => void;
      const heldResponse = new Promise<void>((resolve) => {
        responseHeld = resolve;
      });
      let held = false;
      try {
        await switchE2eProject(fixture.projectPath);
        await page.setViewportSize({ width: 844, height: 390 });
        await page.emulateMedia({
          reducedMotion: reducedMotion ? "reduce" : "no-preference",
        });
        await page.addInitScript((selectedTheme) => {
          localStorage.setItem("daw_theme", selectedTheme);
          localStorage.setItem("sharecut.homeScreenHintDismissed", "1");
        }, theme);
        await page.route("**/api/document/command?*", async (route) => {
          if (
            !held &&
            isMuteRequest(route.request(), fixture.projectPath, "guest", true)
          ) {
            held = true;
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            responseHeld();
            await responseGate;
            await route.fulfill({ response });
          } else await route.continue();
        });
        await openProject(page, fixture.projectPath);
        await setTheme(page, theme);
        await expect(page.locator(".track-header-row")).toHaveCount(2);
        // The stacked tablet gives the lower half to the Script; the timeline
        // takes the whole body once the Script is hidden.
        const folded = await openToolsIfFolded(page);
        await page.getByRole("button", { name: "Show or hide Script" }).click();
        if (folded) await closeTools(page);
        await expect(page.locator(".edit-script")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        await expectMixSettled(page, fixture.projectPath);
        const scroller = page.locator(".timeline-scroll");
        const button = page.getByRole("button", {
          name: "Mute guest",
          exact: true,
        });
        await expectTouchable(page, button);
        await expect(button).toHaveAttribute("aria-pressed", "false");
        await expect(scroller).toHaveJSProperty("scrollTop", 0);
        const onAcknowledgment = muteAcknowledgment(
          page,
          fixture.projectPath,
          "guest",
          true,
        );
        await button.tap();
        await heldResponse;
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(
          page.getByRole("region", { name: /Needs attention/ }),
        ).toBeVisible();
        await expect
          .poll(() => hostOfflineQueueCount(page, fixture.projectPath))
          .toBe(1);
        const center = await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const scrollport = document
            .querySelector(".timeline-scroll")!
            .getBoundingClientRect();
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          return {
            x,
            y,
            inViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
            inScrollport:
              x >= scrollport.left &&
              x <= scrollport.right &&
              y >= scrollport.top &&
              y <= scrollport.bottom,
            ownsHit: element.contains(document.elementFromPoint(x, y)),
          };
        });
        expect(center).toMatchObject({
          inViewport: true,
          inScrollport: true,
          ownsHit: true,
        });
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
        const offAcknowledgment = muteAcknowledgment(
          page,
          fixture.projectPath,
          "guest",
          false,
        );
        await page.touchscreen.tap(center.x, center.y);
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
        await expect(button).toHaveAttribute("aria-pressed", "false");
        await expect(
          page.getByRole("region", { name: /Needs attention/ }),
        ).toBeVisible();
        releaseResponse();
        expect((await onAcknowledgment).ok()).toBe(true);
        expect((await offAcknowledgment).ok()).toBe(true);
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
        await expectMixSettled(page, fixture.projectPath);
        await expect(button).toHaveAttribute("aria-pressed", "false");
        expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
        await expectTouchable(page, button);
      } finally {
        releaseResponse();
        await page.unrouteAll({ behavior: "wait" });
        await switchE2eProject(e2eProjectPath);
        removeRelocatedE2eProject(fixture.workspaceDir);
      }
    });
  });
}
