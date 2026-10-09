import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  expectEnvelopeMutation,
  observeEnvelopeCommands,
} from "./envelopeCreationEvidence";
import {
  captureInspector,
  controlGeometry,
  exposeControl,
  nativeTabTo,
  pointerControl,
  typeControl,
  visibleFocus,
  wheelInspector,
} from "./inspectorResponsiveEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme } from "./theme";

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
  // A phone's timeline selections open the drawer at full, with the inspector.
  if (page.viewportSize()!.width < 720) {
    await rememberInspectorDetent(page, "full");
  }
  await openHostShare(page, projectPath);
  if (page.viewportSize()!.width < 720) {
    await pointerControl(
      page,
      page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("button", { name: "Timeline", exact: true }),
      receipts,
    );
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
async function assertDraftWheel(page: Page, receipts: InteractionReceipt[]) {
  const time = page.getByLabel("Time (seconds on timeline)", { exact: true });
  const level = page.getByLabel("Level (×)", { exact: true });
  const before = [await time.inputValue(), await level.inputValue()];
  await exposeControl(page, time, receipts);
  const geometry = await controlGeometry(time);
  await page.mouse.move(geometry.point.x, geometry.point.y);
  await page.mouse.wheel(0, 220);
  await page.waitForTimeout(100);
  await wheelInspector(page, receipts, 220);
  expect([await time.inputValue(), await level.inputValue()]).toEqual(before);
  receipts.push({
    checkpoint: "wheel-over-numeric-and-body-preserves-draft",
    observation: { before, geometry },
  });
}
async function openClip(page: Page, receipts: InteractionReceipt[]) {
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
  await expect(page.locator(".modifier-badge")).toHaveText("Clip");
}

for (const viewport of viewports)
  for (const rootFont of [16, 32])
    for (const theme of ["light", "dark"] as const) {
      test.describe(`responsive inspector ${viewport.width}x${viewport.height} root${rootFont} ${theme}`, () => {
        test.use({
          viewport,
          reducedMotion: theme === "dark" ? "reduce" : "no-preference",
        });
        test("pointer identity, full envelope controls, visible return and Clip inspector ordinary scrolling", async ({
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
                for (const name of [
                  `Mute ${track.label}`,
                  `Solo ${track.label}`,
                ]) {
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
                for (const name of [
                  "Track label",
                  "Track speaker",
                  "Track role",
                ]) {
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
                    name: "Add volume envelope",
                    exact: true,
                  }),
                  receipts,
                );
                await pointerControl(
                  page,
                  page.getByRole("button", { name: "Add point", exact: true }),
                  receipts,
                );
                const time = page.getByLabel("Time (seconds on timeline)", {
                  exact: true,
                });
                const level = page.getByLabel("Level (×)", { exact: true });
                await typeControl(page, time, "0", receipts);
                await typeControl(page, level, "1", receipts);
                await assertDraftWheel(page, receipts);
                await exposeControl(
                  page,
                  page.getByRole("button", { name: "Cancel", exact: true }),
                  receipts,
                );
                await captureInspector(
                  page,
                  info,
                  receipts,
                  "typed-default-point-full-controls",
                );
                const first = await acceptedEnvelopeCommand(
                  page,
                  "SetEnvelope",
                  () =>
                    pointerControl(
                      page,
                      page.getByRole("button", {
                        name: "Save point",
                        exact: true,
                      }),
                      receipts,
                    ),
                );
                const point = first.command.payload.points![0]!;
                expect(point).toEqual({
                  id: expect.stringMatching(/\S/),
                  time: 0,
                  value: 1,
                });
                await expect
                  .poll(() => envelopeSnapshot(projectPath, track.id).points)
                  .toEqual([point]);
                const saved = envelopeSnapshot(projectPath, track.id);
                expectEnvelopeMutation(origin, saved, track.id);
                const select = page.getByRole("combobox", {
                  name: "Envelope point",
                  exact: true,
                });
                await visibleFocus(
                  select,
                  receipts,
                  "save-restores-visible-point-selector",
                );
                await exposeControl(
                  page,
                  page.getByRole("button", {
                    name: "Remove volume envelope",
                    exact: true,
                  }),
                  receipts,
                );
                await pointerControl(
                  page,
                  page.getByRole("button", { name: "Edit point", exact: true }),
                  receipts,
                );
                await typeControl(page, time, "2", receipts);
                await typeControl(page, level, "0.75", receipts);
                const changed = await acceptedEnvelopeCommand(
                  page,
                  "SetEnvelope",
                  () =>
                    pointerControl(
                      page,
                      page.getByRole("button", {
                        name: "Save point",
                        exact: true,
                      }),
                      receipts,
                    ),
                );
                expect(changed.command.payload.points).toEqual([
                  { ...point, time: 2, value: 0.75 },
                ]);
                await expect
                  .poll(() => envelopeSnapshot(projectPath, track.id).points)
                  .toEqual(changed.command.payload.points);
                const edited = envelopeSnapshot(projectPath, track.id);
                expectEnvelopeMutation(saved, edited, track.id);
                await pointerControl(
                  page,
                  page.getByRole("button", { name: "Edit point", exact: true }),
                  receipts,
                );
                await typeControl(page, time, "3", receipts);
                await assertDraftWheel(page, receipts);
                const commandCount = observer.commands.length;
                await captureInspector(
                  page,
                  info,
                  receipts,
                  "changed-draft-before-cancel",
                );
                await pointerControl(
                  page,
                  page.getByRole("button", { name: "Cancel", exact: true }),
                  receipts,
                );
                expect(envelopeSnapshot(projectPath, track.id)).toEqual(edited);
                expect(observer.commands).toHaveLength(commandCount);
                await visibleFocus(
                  select,
                  receipts,
                  "cancel-restores-visible-point-selector",
                );
                await captureInspector(
                  page,
                  info,
                  receipts,
                  "cancel-visible-focus-no-write",
                );
                receipts.push({
                  checkpoint: "exact-Applied-identities-and-history",
                  observation: { first, changed, origin, saved, edited },
                });
                await pointerControl(
                  page,
                  page.getByRole("button", { name: "Done", exact: true }),
                  receipts,
                );
                await visibleFocus(
                  page.getByRole("button", {
                    name: "Edit volume envelope",
                    exact: true,
                  }),
                  receipts,
                  "done-restores-visible-track-entry",
                );
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

test.describe("independent keyboard envelope root32 phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, reducedMotion: "reduce" });
  test("native Tabs, field errors, Save, Escape, Done and Close keep visible focus", async ({
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
          await rememberInspectorDetent(page, "full");
          await openHostShare(page, projectPath);
          const timeline = page
            .getByRole("navigation", { name: "Primary" })
            .getByRole("button", { name: "Timeline", exact: true });
          await nativeTabTo(page, timeline, receipts);
          await page.keyboard.press("Enter");
          await expect(
            page.locator(
              '.timeline-scroll .track-headers:not([aria-busy="true"])',
            ),
          ).toBeVisible();
          await setTheme(page, "dark");
          await page.locator("html").evaluate((html) => {
            html.style.fontSize = "32px";
          });
          const enter = async (name: string) => {
            await nativeTabTo(
              page,
              page.getByRole("button", { name, exact: true }),
              receipts,
            );
            await page.keyboard.press("Enter");
          };
          await enter(`Open track details, ${track.label}`);
          const expand = page.getByRole("button", {
            name: "Expand",
            exact: true,
          });
          if (await expand.count()) await enter("Expand");
          await enter("Add volume envelope");
          await enter("Add point");
          const time = page.getByLabel("Time (seconds on timeline)", {
            exact: true,
          });
          await visibleFocus(time, receipts, "native-add-visible-time");
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type("-1");
          await enter("Save point");
          const alert = page.locator(".modifier-inspector").getByRole("alert");
          await expect(alert).toContainText(/non.?negative|at least|zero|0/i);
          await visibleFocus(
            page.getByRole("button", { name: "Save point", exact: true }),
            receipts,
            "invalid-save-keeps-visible-focus",
          );
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Shift+Tab");
          await visibleFocus(
            time,
            receipts,
            "native-error-correction-visible-time",
          );
          expect(await time.getAttribute("aria-describedby")).toBe(
            await alert.getAttribute("id"),
          );
          expect((await controlGeometry(alert)).fullyVisible).toBe(true);
          expect(
            observer.commands.filter(
              (command) => command.type === "SetEnvelope",
            ),
          ).toHaveLength(0);
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type("0");
          const accepted = await acceptedEnvelopeCommand(
            page,
            "SetEnvelope",
            () => enter("Save point"),
          );
          await expect
            .poll(() => envelopeSnapshot(projectPath, track.id).points)
            .toEqual(accepted.command.payload.points);
          const saved = envelopeSnapshot(projectPath, track.id);
          expectEnvelopeMutation(origin, saved, track.id);
          const select = page.getByRole("combobox", {
            name: "Envelope point",
            exact: true,
          });
          await visibleFocus(
            select,
            receipts,
            "keyboard-save-visible-selector",
          );
          await enter("Edit point");
          await visibleFocus(time, receipts, "keyboard-edit-visible-time");
          await page.keyboard.press("ControlOrMeta+A");
          await page.keyboard.type("2");
          await page.keyboard.press("Escape");
          await visibleFocus(
            select,
            receipts,
            "keyboard-Escape-visible-selector",
          );
          expect(envelopeSnapshot(projectPath, track.id)).toEqual(saved);
          await enter("Done");
          await visibleFocus(
            page.getByRole("button", {
              name: "Edit volume envelope",
              exact: true,
            }),
            receipts,
            "keyboard-Done-visible-entry",
          );
          await enter("Close");
          await visibleFocus(
            page.getByRole("button", {
              name: `Open track details, ${track.label}`,
              exact: true,
            }),
            receipts,
            "keyboard-Close-visible-identity",
          );
          await captureInspector(
            page,
            info,
            receipts,
            "keyboard-only-complete",
          );
        } finally {
          await observer.retain();
        }
      },
      undefined,
      emptyEnvelopeProject,
    );
  });
});

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
  test("long title, pending lock and wrapped failure keep drafts and recovery actions reachable", async ({
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
              name: "Edit volume envelope",
              exact: true,
            }),
            receipts,
          );
          const select = page.getByRole("combobox", {
            name: "Envelope point",
            exact: true,
          });
          await exposeControl(page, select, receipts);
          await expect(select.locator("option")).toHaveCount(4);
          await pointerControl(page, select, receipts);
          // End/Enter did not commit this native popup on macOS Chromium.
          await select.selectOption("responsive-last");
          await expect(select).toHaveValue("responsive-last");
          await exposeControl(
            page,
            page.getByRole("button", { name: "Delete point", exact: true }),
            receipts,
          );
          await pointerControl(
            page,
            page.getByRole("button", { name: "Edit point", exact: true }),
            receipts,
          );
          const time = page.getByLabel("Time (seconds on timeline)", {
            exact: true,
          });
          const level = page.getByLabel("Level (×)", { exact: true });
          await typeControl(page, time, "3", receipts);
          await typeControl(page, level, "0.8", receipts);
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          let requests = 0;
          const message =
            "This envelope changed while the draft was open. Your point draft is preserved; discard this draft and reload points, then try again.";
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
          const save = page.getByRole("button", {
            name: "Save point",
            exact: true,
          });
          const admission = await exposeControl(page, save, receipts);
          receipts.push({
            checkpoint: "native-double-click-save-admission",
            observation: admission,
          });
          await page.screenshot();
          await page.mouse.dblclick(admission.point.x, admission.point.y);
          await expect.poll(() => requests).toBe(1);
          for (const control of [
            time,
            level,
            save,
            page.getByRole("button", { name: "Cancel", exact: true }),
            page.getByRole("button", { name: "Done", exact: true }),
          ]) {
            await expect(control).toBeDisabled();
            await exposeControl(page, control, receipts);
          }
          await wheelInspector(page, receipts, 220);
          await expect(time).toHaveValue("3");
          await expect(level).toHaveValue("0.8");
          await captureInspector(
            page,
            info,
            receipts,
            "pending-request-full-controls",
          );
          release();
          const alert = page.locator(".modifier-inspector").getByRole("alert");
          await expect(alert).toContainText(message);
          await expect(save).toBeEnabled();
          await exposeControl(page, alert, receipts);
          await expect(time).toHaveValue("3");
          await expect(level).toHaveValue("0.8");
          await exposeControl(
            page,
            page.getByRole("button", {
              name: "Discard draft and reload points",
              exact: true,
            }),
            receipts,
          );
          await captureInspector(
            page,
            info,
            receipts,
            "wrapped-failure-full-recovery",
          );
          await pointerControl(
            page,
            page.getByRole("button", { name: "Cancel", exact: true }),
            receipts,
          );
          await visibleFocus(
            select,
            receipts,
            "failure-cancel-visible-selector",
          );
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
