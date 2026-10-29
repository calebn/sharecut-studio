import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import { layer } from "../e2e/lifecycleAudit";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { inspectSelection, openProject } from "../e2e/stageNav";
import { setTheme, withAppearance } from "../e2e/theme";
import { buildFixture, json, lane, setZoom } from "../e2e/touchTimeline";

let projectPath: string;
let workspaceDir: string;

test.use({ hasTouch: true, reducedMotion: "reduce" });
test.beforeEach(async () => {
  const fixture = createRelocatedE2eProject("sharecut-e2e-feedback-detents-");
  projectPath = fixture.projectPath;
  workspaceDir = fixture.workspaceDir;
  await switchE2eProject(projectPath);
});
test.afterEach(async () => {
  await switchE2eProject(e2eProjectPath);
  removeRelocatedE2eProject(workspaceDir);
});

for (const {
  cell: { viewport, rootPx, inspector },
  theme,
} of withAppearance(
  [
    { width: 390, height: 844 },
    { width: 636, height: 390 },
  ].flatMap((viewport) =>
    [16, 32].flatMap((rootPx) =>
      (["Envelope", "Pending"] as const).map((inspector) => ({
        viewport,
        rootPx,
        inspector,
      })),
    ),
  ),
)) {
  const halfDetent = !(viewport.width > viewport.height && rootPx === 32);
  const detents = halfDetent
    ? (["half", "full"] as const)
    : (["full"] as const);
  const firstExpand = `Expand to ${detents[0]} height`;
  test.describe(`feedback detents ${inspector} ${viewport.width}x${viewport.height} root${rootPx} ${theme}`, () => {
    test("feedback preserves selected half and full geometry and permitted ruler and lane room", async ({
      page,
      context,
      browserName,
    }, info) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript(
        (value) => localStorage.setItem("daw_theme", value),
        theme,
      );
      const fallbackMenu =
        viewport.width === 636 &&
        rootPx === 32 &&
        inspector === "Envelope" &&
        theme === "dark";
      if (fallbackMenu) {
        await page.addInitScript(() => {
          Object.defineProperty(HTMLElement.prototype, "showPopover", {
            value: undefined,
            configurable: true,
          });
          Object.defineProperty(HTMLElement.prototype, "hidePopover", {
            value: undefined,
            configurable: true,
          });
        });
      }
      const safeAreaProbe =
        browserName === "chromium" &&
        rootPx === 32 &&
        theme === "dark" &&
        ((viewport.width === 390 && inspector === "Pending") ||
          (viewport.width === 636 && inspector === "Envelope"));
      const safeAreaSession = safeAreaProbe
        ? await context.newCDPSession(page)
        : null;
      if (safeAreaSession) {
        await safeAreaSession.send("Emulation.setDeviceMetricsOverride", {
          ...viewport,
          deviceScaleFactor: 1,
          mobile: true,
          screenWidth: viewport.width,
          screenHeight: viewport.height,
        });
        await safeAreaSession.send("Emulation.setSafeAreaInsetsOverride", {
          insets: { top: 59, bottom: 34, left: 47, right: 47 },
        });
      }
      await rememberInspectorDetent(page, "half");
      await openProject(page, projectPath);
      await buildFixture(page, projectPath, "e2e-feedback-detents");
      await openProject(page, projectPath);
      await page.setViewportSize(viewport);
      if (viewport.width < 768) await openPhoneTimeline(page);
      await layer(page, "Volume envelope", true);
      if (fallbackMenu) {
        await layer(page, "Volume envelope", false);
        await layer(page, "Volume envelope", true);
      }
      await setTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await setZoom(page, 3);
      const hit =
        inspector === "Envelope"
          ? page.locator(`${lane} [data-hit-id="env-c"]`)
          : page.locator(".pending-overlay .pending-hit").first();
      await hit.focus();
      await hit.press("Enter");
      await inspectSelection(page);
      const panel = page.locator(".bottom-sheet--compact");
      await expect(panel).toBeVisible();
      await page.locator("html").evaluate((html, px) => {
        html.style.fontSize = `${px}px`;
      }, rootPx);
      await page.waitForTimeout(350);
      const withoutFeedback: Record<string, number> = {};
      let halfRulerPermitted = false;
      for (const detent of detents) {
        if (detent === "full" && halfDetent)
          await page
            .getByRole("button", {
              name: "Expand to full height",
              exact: true,
            })
            .click();
        await expect(panel).toHaveClass(new RegExp(`bottom-sheet--${detent}`));
        const box = await panel.boundingBox();
        expect(box).not.toBeNull();
        withoutFeedback[detent] = box!.height;
        if (inspector === "Pending") {
          const review = panel.locator(".pending-actionbar--docked");
          await expect(review).toBeVisible();
          await expect
            .poll(() =>
              review.evaluate((element) =>
                element.parentElement?.parentElement?.classList.contains(
                  "bottom-sheet-body",
                ),
              ),
            )
            .toBe(true);
        }
        if (detent === "half") {
          const slider = page.getByRole("slider", {
            name: "Timeline position",
          });
          let ruler = await controlGeometry(slider);
          let area = ruler.measured[0].visibleArea;
          let point = {
            x: ruler.rect.left + 300,
            y: ruler.rect.top + 12,
          };
          if (
            inspector === "Envelope" &&
            viewport.width === 390 &&
            rootPx === 16 &&
            area.state === "positive" &&
            point.x > area.bounds.right
          ) {
            const timelineScroll = page.locator(".timeline-scroll");
            const scrollLeftBefore = await timelineScroll.evaluate(
              (element) => element.scrollLeft,
            );
            await page.mouse.move(area.bounds.right - 8, point.y);
            await page.mouse.wheel(180, 0);
            await expect
              .poll(async () => {
                const ruler = await controlGeometry(slider);
                const area = ruler.measured[0].visibleArea;
                const point = {
                  x: ruler.rect.left + 300,
                  y: ruler.rect.top + 12,
                };
                return (
                  area.state === "positive" &&
                  point.x >= area.bounds.left &&
                  point.x <= area.bounds.right &&
                  point.y >= area.bounds.top &&
                  point.y <= area.bounds.bottom
                );
              })
              .toBe(true);
            ruler = await controlGeometry(slider);
            area = ruler.measured[0].visibleArea;
            point = {
              x: ruler.rect.left + 300,
              y: ruler.rect.top + 12,
            };
            json(info, "half-ruler-horizontal-wheel", {
              scrollLeftBefore,
              scrollLeftAfter: await timelineScroll.evaluate(
                (element) => element.scrollLeft,
              ),
              ruler,
              point,
            });
          }
          halfRulerPermitted =
            area.state === "positive" &&
            point.x >= area.bounds.left &&
            point.x <= area.bounds.right &&
            point.y >= area.bounds.top &&
            point.y <= area.bounds.bottom &&
            ruler.rect.bottom <= box!.y;
          json(info, "half-without-feedback", {
            ruler,
            panel: await controlGeometry(panel),
          });
          if (rootPx === 16) expect(halfRulerPermitted).toBe(true);
        }
      }
      await page
        .getByRole("button", { name: "Collapse to strip", exact: true })
        .click();
      await page
        .getByRole("button", { name: firstExpand, exact: true })
        .click();
      if (halfRulerPermitted) {
        const slider = page.getByRole("slider", {
          name: "Timeline position",
        });
        const timeBefore =
          inspector === "Envelope"
            ? Number(await slider.getAttribute("aria-valuenow"))
            : undefined;
        json(info, "without-feedback-ruler-before-click", {
          timeBefore,
          ruler: await controlGeometry(slider),
        });
        await slider.click({ position: { x: 300, y: 12 } });
        await expect(panel).not.toBeVisible();
        await expect(page.locator(".pending-actionbar")).toHaveCount(0);
        const timeAfter =
          inspector === "Envelope"
            ? Number(await slider.getAttribute("aria-valuenow"))
            : undefined;
        if (timeBefore !== undefined) expect(timeAfter).not.toBe(timeBefore);
        json(info, "without-feedback-ruler-after-click", {
          timeBefore,
          timeAfter,
          panelVisible: await panel.isVisible(),
          pendingActionbarCount: await page
            .locator(".pending-actionbar")
            .count(),
          ruler: await controlGeometry(slider),
        });
        await hit.focus();
        await hit.press("Enter");
        await inspectSelection(page);
        await expect(panel).toHaveClass(/bottom-sheet--half/);
        expect((await panel.boundingBox())!.height).toBeCloseTo(
          withoutFeedback.half,
          0,
        );
      }
      await page.route("**/api/document/command*", async (route) => {
        const command = route.request().postDataJSON() as {
          type: string;
        };
        if (command.type === "UndoHistory") {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            headers: { "x-sharecut-error-code": "history_stale" },
            body: JSON.stringify({ detail: "Project changed" }),
          });
        } else await route.continue();
      });
      info.annotations.push({
        type: "fault-injection",
        description:
          "Actual history Undo maps controlled HTTP409 history_stale to the production refusal card.",
      });
      await panel.getByRole("button", { name: "Undo", exact: true }).click();
      const card = page.locator(".ui-toast-region--inspector-flow .ui-toast");
      await expect(card).toContainText(
        "Can't undo: the project changed since. Nothing was undone.",
      );
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const attention = page.getByRole("region", {
        name: "Needs attention. 1 conflict",
      });
      await expect(attention).toBeVisible();
      const details = attention.locator("details");
      const summary = details.locator("summary");
      await expect(summary).toHaveAccessibleName(
        "Needs attention details and recovery actions",
      );
      if (halfDetent)
        await page
          .getByRole("button", { name: "Expand to full height", exact: true })
          .click();
      for (const button of await panel
        .locator(".bottom-sheet-header-actions button")
        .all()) {
        const geometry = await controlGeometry(button);
        expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
        expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
      }
      await summary.scrollIntoViewIfNeeded();
      await summary.focus();
      await page.keyboard.press("Enter");
      await expect(details).toHaveAttribute("open", "");
      const reason = details.locator(".guest-attention-list > li").first();
      await expect(reason).toContainText("Project changed");
      await expect(reason).toContainText(
        "Edit the change and submit it again.",
      );
      const dismiss = attention.getByRole("button", {
        name: "Dismiss all",
        exact: true,
      });
      const body = panel.locator(".bottom-sheet-body");
      for (const [name, target] of [
        ["summary", summary],
        ["reason", reason],
        ["dismiss", dismiss],
      ] as const) {
        await target.scrollIntoViewIfNeeded();
        const geometry = await controlGeometry(target);
        json(info, `attention-${name}-body-scroll`, {
          geometry,
          scroll: await body.evaluate((element) => ({
            top: element.scrollTop,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          })),
        });
        expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
        expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
        if (safeAreaProbe) {
          expect(geometry.rect.left).toBeGreaterThanOrEqual(47);
          expect(geometry.rect.right).toBeLessThanOrEqual(viewport.width - 47);
          expect(geometry.rect.top).toBeGreaterThanOrEqual(59);
          expect(geometry.rect.bottom).toBeLessThanOrEqual(
            viewport.height - 34,
          );
        }
      }
      if (inspector === "Pending") {
        for (const reviewAction of await panel
          .locator(".pending-actionbar--docked button")
          .all()) {
          await reviewAction.scrollIntoViewIfNeeded();
          const geometry = await controlGeometry(reviewAction);
          json(info, "pending-review-body-scroll", geometry);
          expect(geometry.fullyVisible, JSON.stringify(geometry)).toBe(true);
          expect(geometry.hitsControl, JSON.stringify(geometry)).toBe(true);
        }
      }
      await expect(attention).toHaveClass(/guest-attention--inspector-flow/);
      await summary.scrollIntoViewIfNeeded();
      await summary.focus();
      await summary.press("Enter");
      await expect(details).not.toHaveAttribute("open", "");
      await expect(
        details.locator(".guest-attention-details-content"),
      ).not.toBeVisible();
      await summary.press("Space");
      await expect(details).toHaveAttribute("open", "");
      await expect(
        details.locator(".guest-attention-details-content"),
      ).toBeVisible();
      await summary.click();
      await expect(details).not.toHaveAttribute("open", "");
      await page
        .getByRole("button", { name: "Collapse to strip", exact: true })
        .click();
      await page
        .getByRole("button", { name: firstExpand, exact: true })
        .click();
      const withFeedback: Record<string, number> = {};
      for (const detent of detents) {
        if (detent === "full" && halfDetent)
          await page
            .getByRole("button", {
              name: "Expand to full height",
              exact: true,
            })
            .click();
        await expect(panel).toHaveClass(new RegExp(`bottom-sheet--${detent}`));
        const box = await panel.boundingBox();
        expect(box).not.toBeNull();
        withFeedback[detent] = box!.height;
        const ruler = await controlGeometry(
          page.getByRole("slider", { name: "Timeline position" }),
        );
        const timeline = await controlGeometry(
          page.locator(".timeline-scroll"),
        );
        json(info, `${detent}-feedback-geometry`, {
          withoutFeedback,
          withFeedback,
          ruler,
          timeline,
          panel: await controlGeometry(panel),
          card: await controlGeometry(card),
        });
        await info.attach(`${detent}-feedback`, {
          body: await page.screenshot({
            path: info.outputPath(`${detent}-feedback.png`),
          }),
          contentType: "image/png",
        });
        expect(withFeedback[detent]).toBeCloseTo(withoutFeedback[detent], 0);
        if (detent === "half") {
          if (halfRulerPermitted) {
            expect(ruler.measured[0].visibleArea.state).toBe("positive");
            expect(ruler.rect.bottom).toBeLessThanOrEqual(box!.y);
          }
          // The ruler and one lane: 104 for a coarse lane, 96 for the 72px
          // lane a phone held sideways draws (24 + 72).
          if (rootPx === 16)
            expect(box!.y - timeline.rect.top).toBeGreaterThanOrEqual(
              viewport.width > viewport.height ? 96 : 104,
            );
        }
      }
      if (halfDetent) expect(withFeedback.half).toBeLessThan(withFeedback.full);
      await page
        .getByRole("button", { name: "Collapse to strip", exact: true })
        .click();
      await page
        .getByRole("button", { name: firstExpand, exact: true })
        .click();
      expect((await panel.boundingBox())!.height).toBeCloseTo(
        withFeedback[detents[0]],
        0,
      );
      if (halfRulerPermitted) {
        const slider = page.getByRole("slider", {
          name: "Timeline position",
        });
        json(info, "with-feedback-ruler-before-click", {
          ruler: await controlGeometry(slider),
          panelVisible: await panel.isVisible(),
          pendingActionbarCount: await page
            .locator(".pending-actionbar")
            .count(),
        });
        await slider.click({ position: { x: 300, y: 12 } });
        await expect(panel).not.toBeVisible();
        await expect(page.locator(".pending-actionbar")).toHaveCount(0);
        json(info, "with-feedback-ruler-after-click", {
          ruler: await controlGeometry(slider),
          panelVisible: await panel.isVisible(),
          pendingActionbarCount: await page
            .locator(".pending-actionbar")
            .count(),
        });
      }
      if (await panel.isVisible()) {
        await panel.getByRole("button", { name: "Close", exact: true }).click();
        await expect(panel).not.toBeVisible();
      }
    });
  });
}
