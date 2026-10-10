import { expect, test } from "@playwright/test";
import { e2eProjectPath } from "../e2e/env";
import { controlGeometry } from "../e2e/inspectorResponsiveEvidence";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "../e2e/liveProject";
import {
  openPhoneTimeline,
  rememberInspectorDetent,
} from "../e2e/phoneTimeline";
import { switchE2eProject } from "../e2e/shareableProject";
import { setTheme } from "../e2e/theme";
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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  for (const rootPx of [16, 32]) {
    for (const theme of ["light", "dark"] as const) {
      for (const inspector of ["Envelope", "Pending"] as const) {
        test.describe(`feedback detents ${inspector} ${viewport.width}x${viewport.height} root${rootPx} ${theme}`, () => {
          test("feedback preserves selected half and full geometry and permitted ruler and lane room", async ({
            page,
          }, info) => {
            await page.setViewportSize({ width: 1280, height: 720 });
            await page.addInitScript(
              (value) => localStorage.setItem("daw_theme", value),
              theme,
            );
            await rememberInspectorDetent(page, "half");
            await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
            await buildFixture(page, projectPath, "e2e-feedback-detents");
            await page.goto(`/?project=${encodeURIComponent(projectPath)}`);
            await page.setViewportSize(viewport);
            if (viewport.width < 768) await openPhoneTimeline(page);
            await setTheme(page, theme);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            await setZoom(page, 3);
            const hit =
              inspector === "Envelope"
                ? page.locator(`${lane} [data-hit-id="env-c"]`)
                : page.locator(".pending-overlay .pending-hit").first();
            await hit.focus();
            await hit.press("Enter");
            const panel = page.locator(".bottom-sheet--compact");
            await expect(panel).toBeVisible();
            await page.locator("html").evaluate((html, px) => {
              html.style.fontSize = `${px}px`;
            }, rootPx);
            await page.waitForTimeout(350);
            const withoutFeedback: Record<string, number> = {};
            let halfRulerPermitted = false;
            for (const detent of ["half", "full"] as const) {
              if (detent === "full")
                await page
                  .getByRole("button", {
                    name: "Expand to full height",
                    exact: true,
                  })
                  .click();
              await expect(panel).toHaveClass(
                new RegExp(`bottom-sheet--${detent}`),
              );
              const box = await panel.boundingBox();
              expect(box).not.toBeNull();
              withoutFeedback[detent] = box!.height;
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
                    .poll(() =>
                      timelineScroll.evaluate((element) => element.scrollLeft),
                    )
                    .toBeGreaterThan(scrollLeftBefore);
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
              .getByRole("button", {
                name: "Expand to half height",
                exact: true,
              })
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
              if (timeBefore !== undefined)
                expect(timeAfter).not.toBe(timeBefore);
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
            await panel
              .getByRole("button", { name: "Undo", exact: true })
              .click();
            const card = page.locator(
              ".ui-toast-region--inspector-flow .ui-toast",
            );
            await expect(card).toContainText(
              "Can't undo: the project changed since. Nothing was undone.",
            );
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            const withFeedback: Record<string, number> = {};
            for (const detent of ["half", "full"] as const) {
              if (detent === "full")
                await page
                  .getByRole("button", {
                    name: "Expand to full height",
                    exact: true,
                  })
                  .click();
              await expect(panel).toHaveClass(
                new RegExp(`bottom-sheet--${detent}`),
              );
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
              expect(withFeedback[detent]).toBeCloseTo(
                withoutFeedback[detent],
                0,
              );
              if (detent === "half") {
                if (halfRulerPermitted) {
                  expect(ruler.measured[0].visibleArea.state).toBe("positive");
                  expect(ruler.rect.bottom).toBeLessThanOrEqual(box!.y);
                }
                if (rootPx === 16)
                  expect(box!.y - timeline.rect.top).toBeGreaterThanOrEqual(
                    104,
                  );
              }
            }
            expect(withFeedback.half).toBeLessThan(withFeedback.full);
            if (halfRulerPermitted) {
              await page
                .getByRole("button", { name: "Collapse to strip", exact: true })
                .click();
              await page
                .getByRole("button", {
                  name: "Expand to half height",
                  exact: true,
                })
                .click();
              expect((await panel.boundingBox())!.height).toBeCloseTo(
                withFeedback.half,
                0,
              );
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
          });
        });
      }
    }
  }
}
