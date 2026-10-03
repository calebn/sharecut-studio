import { expect, test } from "@playwright/test";
import { rulerWidthPx } from "./deepZoom";
import {
  begin,
  draw,
  interrupt,
  layer,
  runAudit,
  snapshot,
} from "./lifecycleAudit";
import {
  createRelocatedE2eProject,
  removeRelocatedE2eProject,
} from "./liveProject";
import { switchE2eProject } from "./shareableProject";

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
for (const family of ["fade", "trim", "envelope"] as const)
  for (const terminal of ["loss", "cancel", "unmount"] as const)
    test(`${family} native preview ${terminal} leaves saved fields and history unchanged`, async ({
      page,
    }, info) => {
      await runAudit(page, info, false, async (p, c) => {
        const block = page
          .locator(
            '.lane-row[data-track-id="reference"] [data-testid="timeline-clip"]',
          )
          .first();
        const target =
          family === "fade"
            ? block.locator(".fade-corner.in")
            : family === "trim"
              ? block.locator(".trim-handle.out")
              : page
                  .locator('circle[aria-label^="Envelope point 1 at"]')
                  .first();
        if (family === "trim") {
          await block.locator(".clip-hit").click();
          await expect(block.locator(".clip-hit")).toHaveAttribute(
            "aria-pressed",
            "true",
          );
        }
        const pointGeometry = () =>
          target.evaluate((element) => ({
            cx: element.getAttribute("cx"),
            cy: element.getAttribute("cy"),
          }));
        const originPoint =
          family === "envelope" ? await pointGeometry() : null;
        const before = snapshot(p),
          origin = await draw(block),
          originCx = Number(await target.getAttribute("cx"));
        const point = await begin(page, target, family === "trim" ? -20 : 20);
        if (family === "fade")
          await expect(block.locator(".clip-fade-line")).not.toHaveCount(0);
        else if (family === "trim")
          await expect
            .poll(async () => (await draw(block)).width)
            .not.toBe(origin.width);
        else
          await expect
            .poll(async () => Number(await target.getAttribute("cx")))
            .toBeCloseTo(originCx + 20, 1);
        expect(snapshot(p)).toEqual(before);
        expect(c.filter((command) => command.type === "SetEnvelope")).toEqual(
          [],
        );
        if (terminal === "unmount" && family === "envelope") {
          await layer(page, "Volume envelope", false);
          await page.mouse.move(point.x + 24, point.y);
          await page.mouse.up();
          await layer(page, "Volume envelope", true);
        } else if (terminal === "unmount") {
          const other = createRelocatedE2eProject("sharecut-e2e-life-switch-");
          try {
            await switchE2eProject(other.projectPath);
            await page.goto(
              `/?project=${encodeURIComponent(other.projectPath)}`,
            );
            await expect(page.locator(".daw-shell")).toBeVisible();
            await page.mouse.up();
            await switchE2eProject(p);
            await page.goto(`/?project=${encodeURIComponent(p)}`);
            await expect(page.locator(".daw-shell")).toBeVisible();
          } finally {
            removeRelocatedE2eProject(other.workspaceDir);
          }
        } else if (family === "envelope") {
          await interrupt(page, target, terminal, point, false);
          await expect.poll(pointGeometry).toEqual(originPoint);
          expect(snapshot(p)).toEqual(before);
          expect(c.filter((command) => command.type === "SetEnvelope")).toEqual(
            [],
          );
          await page.mouse.move(point.x + 40, point.y + 12);
          await expect.poll(pointGeometry).toEqual(originPoint);
          await page.mouse.up();
        } else await interrupt(page, target, terminal, point);
        if (family === "envelope")
          await expect.poll(pointGeometry).toEqual(originPoint);
        expect(snapshot(p)).toEqual(before);
        expect(
          c.filter((v) =>
            ["SetClipFade", "TrimClipEdge", "SetEnvelope"].includes(v.type),
          ),
        ).toEqual([]);
        if (family === "fade")
          await expect(block.locator(".clip-fade-line")).toHaveCount(0);
        if (family === "trim") {
          await expect(block.locator(".clip-trim-ghost")).toHaveCount(0);
          if (terminal === "unmount")
            await expect
              .poll(
                async () =>
                  (await draw(block)).width / (await rulerWidthPx(page)),
              )
              .toBe(1);
          else
            await expect
              .poll(async () => (await draw(block)).width)
              .toBe(origin.width);
        }
      });
    });
