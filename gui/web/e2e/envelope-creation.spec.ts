import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  acceptedEnvelopeCommand,
  addEnvelopePoint,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  expectEnvelopeMutation,
  inspectEnvelopePoint,
  observeEnvelopeCommands,
  openEnvelopePoint,
  openEnvelopeTrackDetails,
  pointSheet,
  setPointField,
  showEnvelope,
} from "./envelopeCreationEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { openPhoneTimeline, rememberInspectorDetent } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setAudition } from "./stageNav";
import { setTheme, type Theme } from "./theme";

async function openEnvelope(
  page: Page,
  projectPath: string,
  theme: Theme,
  receipts: InteractionReceipt[],
  phone = false,
) {
  if (phone) await rememberInspectorDetent(page, "half");
  await openHostShare(page, projectPath);
  if (phone) await openPhoneTimeline(page);
  await setTheme(page, theme);
  const track = envelopeTrack(projectPath);
  await openEnvelopeTrackDetails(page, track.label, receipts);
  await showEnvelope(page);
  return track;
}
async function projectHistoryShortcut(
  page: Page,
  receipts: InteractionReceipt[],
  key: "ControlOrMeta+z" | "ControlOrMeta+Shift+z",
) {
  const close = pointSheet(page).getByRole("button", { name: "Close" });
  await expect(close).toBeEnabled();
  await close.focus();
  await expect(close).toBeFocused();
  receipts.push({
    checkpoint: "project-history-keyboard-focus",
    observation: {
      key,
      target: "enabled Close button (focused, not activated)",
      reason:
        "A Scrub field's text input owns typing shortcuts; project history requires a non-typing target.",
    },
  });
  await page.keyboard.press(key);
}
const savedAt = (page: Page, change: () => Promise<unknown>) =>
  acceptedEnvelopeCommand(page, "SetEnvelope", change);
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
const sheetTime = async (page: Page) =>
  Number(
    await pointSheet(page)
      .getByRole("spinbutton", { name: "Time", exact: true })
      .getAttribute("aria-valuenow"),
  );

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
            if (core.phone) await rememberInspectorDetent(page, "half");
            await openHostShare(page, projectPath);
            if (core.phone) await openPhoneTimeline(page);
            await setTheme(page, core.theme);
            await observer.verifyAssets();
            observer.stage("track-entry");
            await openEnvelopeTrackDetails(page, track.label, receipts);
            await screenshot(page, info, "empty-track-entry");
            const showLayer = page.getByRole("button", {
              name: "Show volume envelope",
              exact: true,
            });
            await expect(showLayer).toHaveAttribute("aria-pressed", "false");
            await showLayer.click();
            const hideLayer = page.getByRole("button", {
              name: "Hide volume envelope",
              exact: true,
            });
            await expect(hideLayer).toHaveAttribute("aria-pressed", "true");
            const unity = page.locator(".envelope-overlay").first();
            await expect(unity).toBeVisible();
            await expect(unity.locator("polyline")).toHaveAttribute(
              "points",
              /\S/,
            );
            await expect(unity.locator("circle")).toHaveCount(0);
            await hideLayer.click();
            await expect(showLayer).toHaveAttribute("aria-pressed", "false");
            await expect(page.locator(".envelope-overlay")).toHaveCount(0);
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            expect(observer.commands).toEqual([]);
            await showLayer.click();
            await expect(hideLayer).toHaveAttribute("aria-pressed", "true");
            expect(envelopeSnapshot(projectPath, track.id)).toEqual(origin);
            expect(observer.commands).toEqual([]);
            observer.stage("first-add");
            const first = await savedAt(page, () => addEnvelopePoint(page));
            expect(first.command.payload.expected_points).toEqual([]);
            const flat = first.command.payload.points!;
            expect(flat.length).toBeGreaterThanOrEqual(2);
            expect(flat.every((item) => item.value === 1)).toBe(true);
            expect(new Set(flat.map((item) => item.id)).size).toBe(flat.length);
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(flat);
            const firstSaved = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(origin, firstSaved, track.id);
            await inspectEnvelopePoint(page);
            const time = await sheetTime(page);
            await screenshot(page, info, "first-point-inspector");
            const point = flat.find((item) => item.time === time);
            expect(point).toBeDefined();
            receipts.push({
              checkpoint: "first-point-applied",
              observation: { first, origin, firstSaved },
            });
            observer.stage("first-undo-redo");
            await acceptedEnvelopeCommand(page, "UndoHistory", () =>
              projectHistoryShortcut(page, receipts, "ControlOrMeta+z"),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([]);
            await acceptedEnvelopeCommand(page, "RedoHistory", () =>
              projectHistoryShortcut(page, receipts, "ControlOrMeta+Shift+z"),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(flat);
            expect(envelopeSnapshot(projectPath, track.id).history).toEqual(
              firstSaved.history,
            );
            observer.stage("level-lowering");
            await inspectEnvelopePoint(page);
            const lowered = await savedAt(page, () =>
              setPointField(page, "Level", "0.5"),
            );
            expect(lowered.command.payload.expected_points).toEqual(flat);
            expect(lowered.command.payload.points).toEqual(
              flat.map((item) =>
                item.id === point!.id ? { ...item, value: 0.5 } : item,
              ),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(lowered.command.payload.points);
            const one = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(firstSaved, one, track.id);
            observer.stage("time-move");
            const moved = await savedAt(page, () =>
              setPointField(page, "Time", "6"),
            );
            expect(moved.command.payload.expected_points).toEqual(one.points);
            const movedPoints = moved.command.payload.points!;
            expect(movedPoints.find((item) => item.id === point!.id)).toEqual({
              id: point!.id,
              time: 6,
              value: 0.5,
            });
            expect(movedPoints.map((item) => item.time)).toEqual(
              [...movedPoints.map((item) => item.time)].sort((a, b) => a - b),
            );
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual(movedPoints);
            const edited = envelopeSnapshot(projectPath, track.id);
            expectEnvelopeMutation(one, edited, track.id);
            observer.stage("reopen-and-remove");
            await page.reload();
            await expect(page.locator(".stage-frame")).toBeVisible();
            if (core.phone) await openPhoneTimeline(page);
            await setTheme(page, core.theme);
            await openEnvelopeTrackDetails(page, track.label, receipts);
            await showEnvelope(page);
            let left = edited;
            while (left.points.length > 1) {
              await openEnvelopePoint(page, 1);
              const removedId = left.points[0]!.id;
              await savedAt(page, () =>
                pointSheet(page)
                  .getByRole("button", { name: "Remove point", exact: true })
                  .click(),
              );
              await expect
                .poll(() => envelopeSnapshot(projectPath, track.id).points)
                .toEqual(left.points.filter((item) => item.id !== removedId));
              const next = envelopeSnapshot(projectPath, track.id);
              expectEnvelopeMutation(left, next, track.id);
              left = next;
            }
            observer.stage("final-removal-and-undo");
            await openEnvelopePoint(page, 1);
            await expect(
              pointSheet(page).getByText(/returns automation to 1.00×/),
            ).toBeVisible();
            const removed = await savedAt(page, () =>
              pointSheet(page)
                .getByRole("button", {
                  name: "Remove volume envelope",
                  exact: true,
                })
                .click(),
            );
            expect(removed.command.payload.points).toEqual([]);
            await expect
              .poll(() => envelopeSnapshot(projectPath, track.id).points)
              .toEqual([]);
            expectEnvelopeMutation(
              left,
              envelopeSnapshot(projectPath, track.id),
              track.id,
            );
            receipts.push({
              checkpoint: "edit-reopen-remove-final-removal",
              observation: { moved, edited, left, removed },
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
    motion: "no-preference" as const,
  },
  {
    name: "short-landscape",
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
    test("point fields remain reachable and refuse a bad level", async ({
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
            await openEnvelope(
              page,
              projectPath,
              profile.theme,
              receipts,
              profile.phone,
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
            observer.stage("responsive-first-create");
            const accepted = await savedAt(page, () => addEnvelopePoint(page));
            await inspectEnvelopePoint(page);
            const dialog = pointSheet(page);
            await setPointField(page, "Level", "9");
            await expect(dialog.getByRole("alert")).toContainText(
              /Enter a number from 0 to 1\.5/,
            );
            await page.keyboard.press("Escape");
            const geometry: unknown[] = [];
            for (const control of [
              dialog.getByRole("spinbutton", { name: "Time", exact: true }),
              dialog.getByRole("spinbutton", { name: "Level", exact: true }),
              dialog.getByRole("button", { name: /^Remove/ }),
            ]) {
              await control.scrollIntoViewIfNeeded();
              await expect(control).toBeVisible();
              const rectangle = await control.boundingBox();
              expect(rectangle).not.toBeNull();
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
            await screenshot(page, info, `${profile.name}-point-fields`);
            await settle(page);
            expect(
              observer.commands.filter((item) => item.type === "SetEnvelope"),
            ).toHaveLength(1);
            const saved = envelopeSnapshot(projectPath, track.id);
            expect(saved.points).toEqual(accepted.command.payload.points);
            expectEnvelopeMutation(origin, saved, track.id);
            receipts.push({
              checkpoint: profile.name,
              observation: { profile, geometry, pageWidth, origin, saved },
            });
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
          await openEnvelope(page, projectPath, "dark", receipts);
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
          await setAudition(page, "raw");
          const accepted = await savedAt(page, () => addEnvelopePoint(page));
          await expect
            .poll(() => envelopeSnapshot(projectPath, track.id).points)
            .toEqual(accepted.command.payload.points);
          const flat = envelopeSnapshot(projectPath, track.id);
          expect(flat.points.length).toBeGreaterThanOrEqual(2);
          let expectedPoints = flat.points;
          for (const [index, point] of flat.points.entries()) {
            await openEnvelopePoint(page, index + 1);
            const lowered = await savedAt(page, () =>
              setPointField(page, "Level", "0.4"),
            );
            const expected = expectedPoints.map((candidate) =>
              candidate.id === point.id
                ? { ...candidate, value: 0.4 }
                : candidate,
            );
            expect(lowered.command.payload.expected_points).toEqual(
              expectedPoints,
            );
            expect(lowered.command.payload.points).toEqual(expected);
            expectedPoints = expected;
          }
          const saved = envelopeSnapshot(projectPath, track.id);
          expect(saved.points).toEqual(expectedPoints);
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
