import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  expectEnvelopeMutation,
  observeEnvelopeCommands,
  openEnvelopeTrackDetails,
} from "./envelopeCreationEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setTheme, type Theme } from "./theme";

async function openWorkspace(
  page: Page,
  projectPath: string,
  theme: Theme,
  receipts: InteractionReceipt[],
  phone = false,
  shortExpanded = false,
) {
  await openHostShare(page, projectPath);
  if (phone) await openPhoneTimeline(page);
  await setTheme(page, theme);
  const track = envelopeTrack(projectPath);
  await openEnvelopeTrackDetails(page, track.label, receipts);
  if (shortExpanded) {
    const inspector = page.getByRole("dialog", {
      name: "Inspector",
      exact: true,
    });
    const expand = inspector.getByRole("button", {
      name: "Expand",
      exact: true,
    });
    await expect(expand).toBeVisible();
    await expect(expand).toBeEnabled();
    await expand.click();
    await expect(inspector).toHaveClass(/bottom-sheet--full/);
    await expect(
      inspector.getByRole("button", { name: "Collapse", exact: true }),
    ).toBeVisible();
    receipts.push({
      checkpoint: "short-viewport-public-expand",
      observation: {
        viewport: page.viewportSize(),
        inspectorRect: await inspector.boundingBox(),
        state: "full Inspector with visible Collapse control",
        action: "native click on visible enabled Expand before envelope entry",
      },
    });
  }
  await page
    .getByRole("button", { name: "Add volume envelope", exact: true })
    .click();
  await expect(
    page.getByText("Editing volume envelope", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".modifier-inspector h2")).toHaveText(track.label);
  return track;
}
async function projectHistoryShortcut(
  page: Page,
  receipts: InteractionReceipt[],
  key: "ControlOrMeta+z" | "ControlOrMeta+Shift+z",
) {
  const done = page.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  await expect(done).toBeEnabled();
  await done.focus();
  await expect(done).toBeFocused();
  receipts.push({
    checkpoint: "project-history-keyboard-focus",
    observation: {
      key,
      target: "visible enabled Done button (focused, not activated)",
      reason:
        "Native SELECT owns typing shortcuts; project history requires a non-typing target.",
    },
  });
  await page.keyboard.press(key);
}
async function fillPoint(page: Page, time: string, level: string) {
  await page
    .getByLabel("Time (seconds on timeline)", { exact: true })
    .fill(time);
  await page.getByLabel("Level (×)", { exact: true }).fill(level);
}
async function savePoint(page: Page) {
  return acceptedEnvelopeCommand(page, "SetEnvelope", () =>
    page.getByRole("button", { name: "Save point", exact: true }).click(),
  );
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await info.attach(name, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
}
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const core of [
  {
    name: "desktop-light",
    viewport: { width: 1440, height: 900 },
    theme: "light" as const,
    phone: false,
  },
  {
    name: "phone-dark",
    viewport: { width: 360, height: 740 },
    theme: "dark" as const,
    phone: true,
  },
])
  test.describe(`volume envelope creation ${core.name}`, () => {
    test.use({ viewport: core.viewport, reducedMotion: "reduce" });
    test("empty track creates edits removes and restores exact points", async ({
      page,
      receipts,
    }, info) => {
      await withShareableProject(
        async (projectPath) => {
          const track = envelopeTrack(projectPath);
          const origin = envelopeSnapshot(projectPath, track.id);
          const observer = observeEnvelopeCommands(
            page,
            projectPath,
            track.id,
            receipts,
          );
          try {
            await openHostShare(page, projectPath);
            if (core.phone) await openPhoneTimeline(page);
            await setTheme(page, core.theme);
            await observer.verifyAssets();
            observer.stage("track-entry");
            await openEnvelopeTrackDetails(page, track.label, receipts);
            await screenshot(page, info, "empty-track-entry");
            await page
              .getByRole("button", { name: "Add volume envelope", exact: true })
              .click();
            await expect(
              page.getByText("Editing volume envelope", { exact: true }),
            ).toBeVisible();
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            expect(observer.commands).toEqual([]);
            await screenshot(page, info, "empty-envelope-workspace");
            observer.stage("first-draft-cancel");
            await page
              .getByRole("button", { name: "Add point", exact: true })
              .click();
            await expect(
              page.getByLabel("Time (seconds on timeline)"),
            ).toHaveValue("0");
            await expect(page.getByLabel("Level (×)")).toHaveValue("1");
            await fillPoint(page, "2", "0.5");
            await page.keyboard.press("Escape");
            await expect(
              page.getByRole("button", { name: "Add point", exact: true }),
            ).toBeFocused();
            expect(observer.commands).toEqual([]);
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            await page
              .getByRole("button", { name: "Add point", exact: true })
              .click();
            observer.stage("first-save");
            const first = await savePoint(page);
            expect(first.command.payload.expected_points).toEqual([]);
            const point = first.command.payload.points?.[0];
            expect(point).toEqual({
              id: expect.stringMatching(/\S/),
              time: 0,
              value: 1,
            });
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([point]);
            const one = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(origin, one, track.id);
            await expect(
              page.getByRole("combobox", {
                name: "Envelope point",
                exact: true,
              }),
            ).toHaveValue(point!.id);
            receipts.push({
              checkpoint: "first-point-applied",
              observation: { first, origin, one },
            });
            observer.stage("first-undo-redo");
            const undoFirst = await acceptedEnvelopeCommand(
              page,
              "UndoHistory",
              () => projectHistoryShortcut(page, receipts, "ControlOrMeta+z"),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([]);
            expect(
              envelopeSnapshot(projectPath, track.id).history?.cursor,
            ).toBe(0);
            const redoFirst = await acceptedEnvelopeCommand(
              page,
              "RedoHistory",
              () =>
                projectHistoryShortcut(page, receipts, "ControlOrMeta+Shift+z"),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([point]);
            expect(envelopeSnapshot(projectPath, track.id).history).toEqual(
              one.history,
            );
            receipts.push({
              checkpoint: "first-point-one-step-undo-redo",
              observation: {
                undoFirst,
                redoFirst,
                restored: envelopeSnapshot(projectPath, track.id),
              },
            });
            await page
              .getByRole("button", { name: "Add point", exact: true })
              .click();
            await fillPoint(page, "4", "0.5");
            observer.stage("second-save");
            const second = await savePoint(page);
            const secondPoint = second.command.payload.points?.find(
              (item) => item.id !== point!.id,
            );
            expect(secondPoint).toEqual({
              id: expect.stringMatching(/\S/),
              time: 4,
              value: 0.5,
            });
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(second.command.payload.points);
            const two = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(one, two, track.id);
            await page
              .getByRole("combobox", { name: "Envelope point", exact: true })
              .selectOption(point!.id);
            await page
              .getByRole("button", { name: "Edit point", exact: true })
              .click();
            await fillPoint(page, "6", "0.8");
            await screenshot(page, info, "populated-envelope-edit-draft");
            observer.stage("numeric-reorder");
            const moved = await savePoint(page);
            const expected = [secondPoint!, { ...point!, time: 6, value: 0.8 }];
            expect(moved.command.payload.points).toEqual(expected);
            expect(moved.command.payload.expected_points).toEqual(two.points);
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(expected);
            const edited = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(two, edited, track.id);
            observer.stage("reopen-and-delete");
            await page.reload();
            await expect(page.locator(".daw-shell")).toBeVisible();
            if (core.phone) await openPhoneTimeline(page);
            await setTheme(page, core.theme);
            await openEnvelopeTrackDetails(page, track.label, receipts);
            await page
              .getByRole("button", {
                name: "Edit volume envelope",
                exact: true,
              })
              .click();
            await page
              .getByRole("combobox", { name: "Envelope point", exact: true })
              .selectOption(point!.id);
            expect(envelopeSnapshot(projectPath, track.id).points).toEqual(
              expected,
            );
            const deleted = await acceptedEnvelopeCommand(
              page,
              "SetEnvelope",
              () =>
                page
                  .getByRole("button", { name: "Delete point", exact: true })
                  .click(),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([secondPoint]);
            const remaining = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(edited, remaining, track.id);
            observer.stage("final-removal-and-undo");
            const removed = await acceptedEnvelopeCommand(
              page,
              "SetEnvelope",
              () =>
                page
                  .getByRole("button", {
                    name: "Remove volume envelope",
                    exact: true,
                  })
                  .click(),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([]);
            const empty = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(remaining, empty, track.id);
            expect(removed.command.payload.points).toEqual([]);
            await screenshot(page, info, "removed-envelope-empty-workspace");
            const undoRemoval = await acceptedEnvelopeCommand(
              page,
              "UndoHistory",
              () => projectHistoryShortcut(page, receipts, "ControlOrMeta+z"),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([secondPoint]);
            expect(
              envelopeSnapshot(projectPath, track.id).history?.cursor,
            ).toBe(remaining.history?.cursor);
            expect(
              observer.commands.filter(
                (command) => command.type === "SetEnvelope",
              ),
            ).toHaveLength(5);
            receipts.push({
              checkpoint: "edit-reopen-delete-final-removal",
              observation: {
                second,
                moved,
                deleted,
                removed,
                undoRemoval,
                two,
                edited,
                remaining,
                empty,
              },
            });
            await observer.verifyAssets();
          } finally {
            await observer.retain();
          }
        },
        undefined,
        emptyEnvelopeProject,
      );
    });
  });

const profiles = [
  {
    name: "phone-keyboard-height-simulation",
    shortExpanded: true,
    width: 360,
    height: 400,
    theme: "light" as const,
    phone: true,
    text: false,
    motion: "reduce" as const,
  },
  {
    name: "phone-light",
    width: 360,
    height: 740,
    theme: "light" as const,
    phone: true,
    text: false,
    motion: "reduce" as const,
  },
  {
    name: "phone-dark",
    width: 360,
    height: 740,
    theme: "dark" as const,
    phone: true,
    text: false,
    motion: "no-preference" as const,
  },
  {
    name: "short-landscape",
    shortExpanded: true,
    width: 640,
    height: 360,
    theme: "dark" as const,
    phone: true,
    text: false,
    motion: "reduce" as const,
  },
  {
    name: "tablet",
    width: 900,
    height: 900,
    theme: "light" as const,
    phone: false,
    text: false,
    motion: "reduce" as const,
  },
  {
    name: "desktop-200-percent-text",
    width: 1440,
    height: 900,
    theme: "dark" as const,
    phone: false,
    text: true,
    motion: "reduce" as const,
  },
];
for (const profile of profiles) {
  test.describe(profile.name, () => {
    test.use({
      viewport: { width: profile.width, height: profile.height },
      reducedMotion: profile.motion,
    });
    test("empty envelope form remains reachable and cancelable", async ({
      page,
      receipts,
    }, info) => {
      await withShareableProject(
        async (projectPath) => {
          const track = envelopeTrack(projectPath);
          const origin = envelopeSnapshot(projectPath, track.id);
          const observer = observeEnvelopeCommands(
            page,
            projectPath,
            track.id,
            receipts,
          );
          try {
            await openWorkspace(
              page,
              projectPath,
              profile.theme,
              receipts,
              profile.phone,
              "shortExpanded" in profile && profile.shortExpanded,
            );
            const originalFont = await page
              .locator("html")
              .evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).fontSize),
              );
            if (profile.text)
              await page.locator("html").evaluate((element, size) => {
                element.style.fontSize = `${size * 2}px`;
              }, originalFont);
            await page
              .getByRole("button", { name: "Add point", exact: true })
              .click();
            await fillPoint(page, "2", "9");
            await page
              .getByRole("button", { name: "Save point", exact: true })
              .click();
            const level = page.getByLabel("Level (×)", { exact: true });
            await expect(level).toHaveAttribute("aria-invalid", "true");
            const description = await level.getAttribute("aria-describedby");
            expect(description).toBeTruthy();
            await expect(page.locator(`[id="${description}"]`)).toContainText(
              "Level must",
            );
            const geometry: unknown[] = [];
            for (const control of [
              page.getByLabel("Time (seconds on timeline)", { exact: true }),
              level,
              page.getByRole("button", { name: "Save point", exact: true }),
              page.getByRole("button", { name: "Cancel", exact: true }),
            ]) {
              await control.scrollIntoViewIfNeeded();
              await expect(control).toBeVisible();
              const rectangle = await control.boundingBox();
              expect(rectangle).not.toBeNull();
              expect(rectangle!.height).toBeGreaterThanOrEqual(44);
              expect(rectangle!.x).toBeGreaterThanOrEqual(0);
              expect(rectangle!.x + rectangle!.width).toBeLessThanOrEqual(
                profile.width + 1,
              );
              expect(rectangle!.y).toBeGreaterThanOrEqual(0);
              expect(rectangle!.y + rectangle!.height).toBeLessThanOrEqual(
                profile.height + 1,
              );
              geometry.push(rectangle);
            }
            const pageWidth = await page.evaluate(() => ({
              scroll: document.documentElement.scrollWidth,
              viewport: innerWidth,
              font: Number.parseFloat(
                getComputedStyle(document.documentElement).fontSize,
              ),
            }));
            expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.viewport);
            if (profile.text)
              expect(pageWidth.font).toBeCloseTo(originalFont * 2, 2);
            await screenshot(page, info, `${profile.name}-validation-form`);
            await page
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            await expect(
              page.getByRole("button", { name: "Add point", exact: true }),
            ).toBeFocused();
            await page
              .getByRole("button", { name: "Done", exact: true })
              .click();
            await expect(
              page.getByRole("button", {
                name: "Add volume envelope",
                exact: true,
              }),
            ).toBeFocused();
            await settle(page);
            expect(observer.commands).toEqual([]);
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            receipts.push({
              checkpoint: profile.name,
              observation: { profile, geometry, pageWidth, origin },
            });
            if (profile.name === "phone-light" || profile.name === "tablet") {
              observer.stage("responsive-first-create");
              await page
                .getByRole("button", {
                  name: "Add volume envelope",
                  exact: true,
                })
                .click();
              await page
                .getByRole("button", { name: "Add point", exact: true })
                .click();
              const accepted = await savePoint(page);
              await expect
                .poll(() => envelopeSnapshot(projectPath, track.id).points)
                .toEqual(accepted.command.payload.points);
              const saved = envelopeSnapshot(projectPath, track.id);
              expectEnvelopeMutation(origin, saved, track.id);
              await expect(
                page.getByRole("combobox", {
                  name: "Envelope point",
                  exact: true,
                }),
              ).toHaveValue(saved.points[0]!.id);
              await screenshot(
                page,
                info,
                `${profile.name}-first-point-created`,
              );
              receipts.push({
                checkpoint: `${profile.name}-first-point-applied`,
                observation: { accepted, origin, saved },
              });
            }
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

test.describe("host envelope playback", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  test("created envelope reaches actual host edited-stem media playback", async ({
    page,
    receipts,
  }, info) => {
    await withShareableProject(
      async (projectPath) => {
        const track = envelopeTrack(projectPath);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        try {
          await openWorkspace(page, projectPath, "dark", receipts);
          const { proveHostEnvelopePlayback, compareConstantEnvelopePcm } =
            await import("./envelopePlaybackEvidence");
          observer.stage("actual-unity-playback-baseline");
          const baseline = await proveHostEnvelopePlayback(
            page,
            projectPath,
            track.id,
            receipts,
          );
          receipts.push({
            checkpoint: "actual-unity-playback-baseline",
            observation: baseline.receipt,
          });
          await page
            .getByRole("button", { name: "Original", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Add point", exact: true })
            .click();
          await fillPoint(page, "0", "0.4");
          const accepted = await savePoint(page);
          await expect
            .poll(() => envelopeSnapshot(projectPath, track.id).points)
            .toEqual(accepted.command.payload.points);
          const saved = envelopeSnapshot(projectPath, track.id);
          observer.stage("actual-nonunity-playback");
          const playback = await proveHostEnvelopePlayback(
            page,
            projectPath,
            track.id,
            receipts,
          );
          expect(envelopeSnapshot(projectPath, track.id).points).toEqual(
            saved.points,
          );
          receipts.push({
            checkpoint: "host-edited-stem-playback",
            observation: {
              accepted,
              saved,
              baseline: baseline.receipt,
              playback: playback.receipt,
              pcm: compareConstantEnvelopePcm(baseline.pcm, playback.pcm, 0.4),
            },
          });
          await screenshot(page, info, "host-envelope-playback-paused");
        } finally {
          await observer.retain();
        }
      },
      undefined,
      emptyEnvelopeProject,
    );
  });
});
