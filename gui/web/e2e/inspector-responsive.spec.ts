import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  addEnvelopePoint,
  dismissToast,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  expectEnvelopeMutation,
  inspectEnvelopePoint,
  observeEnvelopeCommands,
  openEnvelopePoint,
  pointSheet,
  setPointField,
} from "./envelopeCreationEvidence";
import {
  captureInspector,
  exposeControl,
  pointerControl,
  wheelInspector,
} from "./inspectorResponsiveEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { closeTools, inspectSelection, openToolsIfFolded } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

const viewports = [
  { width: 360, height: 740 },
  { width: 360, height: 800 },
  { width: 667, height: 360 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
];
async function setup(
  page: Page,
  projectPath: string,
  theme: "light" | "dark",
  rootFont: number,
  receipts: InteractionReceipt[],
) {
  // A phone's or tablet's timeline selections open the drawer at full, with
  // the inspector.
  if (page.viewportSize()!.width < 1000) {
    await rememberInspectorDetent(page, "full");
  }
  await openHostShare(page, projectPath);
  if (page.viewportSize()!.width < 720) {
    // A frame too short for its rows folds the surface switch into Tools.
    const folded = await openToolsIfFolded(page);
    await pointerControl(
      page,
      page
        .getByRole("group", { name: "Edit surface" })
        .getByRole("button", { name: "Timeline", exact: true }),
      receipts,
    );
    if (folded) await closeTools(page);
  }
  await expect(
    page.locator('.timeline-scroll .track-headers:not([aria-busy="true"])'),
  ).toBeVisible();
  await setTheme(page, theme);
  await page.locator("html").evaluate((html, px) => {
    html.style.fontSize = `${px}px`;
  }, rootFont);
  receipts.push({
    checkpoint: "scaling-evidence-label",
    observation: {
      rootFont,
      evidence:
        rootFont === 32
          ? "200% CSS root-font simulation (32px); not browser/OS zoom, physical device, or software keyboard evidence"
          : "Normal 16px CSS root text in desktop Chromium",
      viewport: page.viewportSize(),
      theme,
    },
  });
}
async function openClip(page: Page, receipts: InteractionReceipt[]) {
  await dismissToast(page);
  const hit = page.locator(".lane-row .clip-hit").first();
  const geometry = await hit.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scroll = element.closest(".timeline-scroll")!.getBoundingClientRect();
    const left = Math.max(rect.left, scroll.left),
      right = Math.min(rect.right, scroll.right, innerWidth);
    const top = Math.max(rect.top, scroll.top),
      bottom = Math.min(rect.bottom, scroll.bottom, innerHeight);
    const point = { x: left + (right - left) / 2, y: top + (bottom - top) / 2 };
    return {
      point,
      visibleCanvas: { left, right, top, bottom },
      hits: document.elementFromPoint(point.x, point.y) === element,
    };
  });
  receipts.push({
    checkpoint: "clip-visible-canvas-entry",
    observation: geometry,
  });
  expect(geometry.hits).toBe(true);
  await page.screenshot();
  await page.mouse.click(geometry.point.x, geometry.point.y);
  await inspectSelection(page);
  await expect(page.locator(".modifier-badge")).toHaveText("Clip");
}

for (const {
  cell: { viewport, rootFont },
  theme,
  reducedMotion,
} of withAppearance(
  viewports.flatMap((viewport) =>
    [16, 32]
      .filter((rootFont) => !(rootFont === 32 && viewport.height === 360))
      .map((rootFont) => ({ viewport, rootFont })),
  ),
)) {
  test.describe(`responsive inspector ${viewport.width}x${viewport.height} root${rootFont} ${theme}`, () => {
    test.use({
      viewport,
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    test("pointer identity, full point controls and Clip inspector ordinary scrolling", async ({
      page,
      receipts,
    }, info) => {
      await withShareableProject(
        async (projectPath) => {
          const track = envelopeTrack(projectPath),
            origin = envelopeSnapshot(projectPath, track.id);
          const observer = observeEnvelopeCommands(
            page,
            projectPath,
            track.id,
            receipts,
          );
          try {
            await setup(page, projectPath, theme, rootFont, receipts);
            await observer.verifyAssets();
            const identity = page.getByRole("button", {
              name: `Open track details, ${track.label}`,
              exact: true,
            });
            await captureInspector(
              page,
              info,
              receipts,
              "before-visible-pointer-entry",
            );
            await pointerControl(page, identity, receipts, true);
            const trackInspector = page.locator(".modifier-inspector");
            for (const name of [`Mute ${track.label}`, `Solo ${track.label}`]) {
              await exposeControl(
                page,
                trackInspector.getByRole("button", { name, exact: true }),
                receipts,
              );
            }
            await exposeControl(
              page,
              trackInspector.getByRole("slider", {
                name: `Volume ${track.label}`,
                exact: true,
              }),
              receipts,
            );
            const resetVolume = trackInspector.getByRole("button", {
              name: "Reset volume to 0 dB",
              exact: true,
            });
            await exposeControl(page, resetVolume, receipts);
            await captureInspector(
              page,
              info,
              receipts,
              "track-volume-reset-full-control",
            );
            const clearClip = trackInspector.getByRole("button", {
              name: `Clear clip light for ${track.label}`,
              exact: true,
            });
            await exposeControl(page, clearClip, receipts);
            const controlFonts = await Promise.all(
              [clearClip, resetVolume].map((control) =>
                control.evaluate(
                  (element) => getComputedStyle(element).fontSize,
                ),
              ),
            );
            expect(controlFonts[0]).toBe(controlFonts[1]);
            receipts.push({
              checkpoint: "Clear-clip-shared-theme-text-scale",
              observation: {
                rootFont,
                controlFonts,
                clearDisabled: await clearClip.isDisabled(),
              },
            });
            await captureInspector(
              page,
              info,
              receipts,
              "track-clear-clip-full-control",
            );
            for (const name of ["Track label", "Track speaker", "Track role"]) {
              await exposeControl(
                page,
                trackInspector.getByLabel(name, { exact: true }),
                receipts,
              );
            }
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            await pointerControl(
              page,
              page.getByRole("button", {
                name: "Show volume envelope",
                exact: true,
              }),
              receipts,
            );
            const first = await acceptedEnvelopeCommand(
              page,
              "SetEnvelope",
              () => addEnvelopePoint(page),
            );
            await inspectEnvelopePoint(page);
            const initialPoints = first.command.payload.points!;
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(initialPoints);
            const saved = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(origin, saved, track.id);
            const dialog = pointSheet(page);
            const time = dialog.getByRole("spinbutton", {
              name: "Time",
              exact: true,
            });
            const level = dialog.getByRole("spinbutton", {
              name: "Level",
              exact: true,
            });
            for (const control of [
              time,
              level,
              dialog.getByRole("button", { name: /^Remove/ }),
            ]) {
              await exposeControl(page, control, receipts);
            }
            const shownTime = Number(await time.getAttribute("aria-valuenow"));
            const point = initialPoints.find(
              (item) => item.time === shownTime,
            )!;
            await captureInspector(
              page,
              info,
              receipts,
              "point-fields-full-controls",
            );
            const changed = await acceptedEnvelopeCommand(
              page,
              "SetEnvelope",
              () => setPointField(page, "Level", "0.75"),
            );
            expect(changed.command.payload.points).toEqual(
              saved.points.map((savedPoint) =>
                savedPoint.id === point.id
                  ? { ...savedPoint, value: 0.75 }
                  : savedPoint,
              ),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(changed.command.payload.points);
            const edited = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(saved, edited, track.id);
            await dismissToast(page, "Envelope point changed");
            const commandCount = observer.commands.length;
            await wheelInspector(page, receipts, 220);
            await expect(level).toHaveAttribute("aria-valuenow", "0.75");
            expect(observer.commands).toHaveLength(commandCount);
            receipts.push({
              checkpoint: "exact-Applied-identities-and-history",
              observation: { first, changed, origin, saved, edited },
            });
            const close = page.getByRole("button", {
              name: "Close",
              exact: true,
            });
            if (await close.count())
              await pointerControl(page, close, receipts);
            await openClip(page, receipts);
            for (const label of ["Fade in ms", "Fade out ms"]) {
              await exposeControl(
                page,
                page.getByLabel(label, { exact: true }),
                receipts,
              );
            }
            await exposeControl(
              page,
              page.getByRole("button", { name: "Seek join", exact: true }),
              receipts,
            );
            await captureInspector(
              page,
              info,
              receipts,
              "clip-inspector-full-actions",
            );
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(edited);
          } finally {
            await observer.retain();
          }
        },
        undefined,
        emptyEnvelopeProject,
      );
    });
  });
}

function manyPointLongNameProject(prefix: string) {
  const fixture = emptyEnvelopeProject(prefix);
  const project = JSON.parse(fs.readFileSync(fixture.projectPath, "utf8"));
  const track = project.timeline.tracks[0];
  track.label =
    "Reference dialogue with a deliberately long descriptive track name";
  project.mix.automation_envelopes = [
    {
      track_id: track.id,
      parameter: "volume",
      points: [
        { id: "responsive-first", time: 0, value: 1 },
        { id: "responsive-middle", time: 10, value: 0.7 },
        { id: "responsive-last", time: 20, value: 1.2 },
      ],
    },
  ];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

test.describe("root32 phone many points and request recovery", () => {
  test.use({ viewport: { width: 360, height: 800 }, reducedMotion: "reduce" });
  test("long title, pending lock and wrapped failure keep the point fields and recovery actions reachable", async ({
    page,
    receipts,
  }, info) => {
    await withShareableProject(
      async (projectPath) => {
        const track = envelopeTrack(projectPath),
          saved = envelopeSnapshot(projectPath, track.id);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        let release = () => {};
        try {
          await setup(page, projectPath, "dark", 32, receipts);
          await pointerControl(
            page,
            page.getByRole("button", {
              name: `Open track details, ${track.label}`,
              exact: true,
            }),
            receipts,
            true,
          );
          await pointerControl(
            page,
            page.getByRole("button", {
              name: "Show volume envelope",
              exact: true,
            }),
            receipts,
          );
          await expect(
            page.locator('circle[aria-label^="Envelope point"]'),
          ).toHaveCount(3);
          await openEnvelopePoint(page, 3);
          const dialog = pointSheet(page);
          const time = dialog.getByRole("spinbutton", {
            name: "Time",
            exact: true,
          });
          const level = dialog.getByRole("spinbutton", {
            name: "Level",
            exact: true,
          });
          const remove = dialog.getByRole("button", { name: /^Remove/ });
          await exposeControl(page, time, receipts);
          await exposeControl(page, remove, receipts);
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let requests = 0;
          const message =
            "This envelope changed while the point was open. Reload points, then try again.";
          await page.route(
            (url) => url.pathname === "/api/document/command",
            async (route) => {
              if (route.request().postDataJSON()?.type !== "SetEnvelope") {
                await route.continue();
                return;
              }
              requests += 1;
              await gate;
              await route.fulfill({
                status: 409,
                contentType: "application/json",
                body: JSON.stringify({ detail: message }),
              });
            },
          );
          await exposeControl(page, level, receipts);
          await setPointField(page, "Level", "0.8");
          await expect.poll(() => requests).toBe(1);
          for (const control of [time, level]) {
            await expect(control).toHaveAttribute("aria-readonly", "true");
            await exposeControl(page, control, receipts);
          }
          await wheelInspector(page, receipts, 220);
          await captureInspector(
            page,
            info,
            receipts,
            "pending-request-full-controls",
          );
          release();
          const alert = dialog.getByRole("alert");
          await expect(alert).toContainText(message);
          await exposeControl(page, alert, receipts);
          const reload = dialog.getByRole("button", {
            name: "Reload points",
            exact: true,
          });
          await exposeControl(page, reload, receipts);
          await captureInspector(
            page,
            info,
            receipts,
            "wrapped-failure-full-recovery",
          );
          await pointerControl(page, reload, receipts);
          await expect(alert).toHaveCount(0);
          expect(requests).toBe(1);
          expect(envelopeSnapshot(projectPath, track.id)).toEqual(saved);
        } finally {
          release();
          await observer.retain();
        }
      },
      undefined,
      manyPointLongNameProject,
    );
  });
});
