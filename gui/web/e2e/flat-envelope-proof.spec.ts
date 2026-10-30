import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { LONG_PRESS_MS } from "../src/hooks/gestureConstants";
import {
  acceptedEnvelopeCommand,
  emptyEnvelopeProject,
  envelopeSnapshot,
  envelopeTrack,
  expectEnvelopeMutation,
  observeEnvelopeCommands,
  openEnvelopeTrackDetails,
  showEnvelope,
} from "./envelopeCreationEvidence";
import { type InteractionReceipt, test } from "./interactionEvidence";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { touch, touchDrag } from "./touchTimeline";

type TrustedEvent = {
  type: string;
  trusted: boolean;
  pointerType?: string;
  key?: string;
  target?: string | null;
};

async function openFlatEnvelope(
  page: Page,
  projectPath: string,
  receipts: InteractionReceipt[],
) {
  const track = envelopeTrack(projectPath);
  await openHostShare(page, projectPath);
  await openEnvelopeTrackDetails(page, track.label, receipts);
  await showEnvelope(page);
  await expect(page.locator(".envelope-overlay").first()).toBeVisible();
  return track;
}

async function createMenuCancels(page: Page, level: Locator) {
  await level.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: /^Create at / });
  await expect(
    menu.getByRole("menuitem", { name: /Add envelope point/ }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

async function recordTrustedEvents(page: Page) {
  await page.evaluate(() => {
    const events: TrustedEvent[] = [];
    Object.assign(window, { __flatEnvelopeEvents: events });
    for (const type of [
      "pointerdown",
      "pointermove",
      "pointerup",
      "pointercancel",
      "click",
      "keydown",
      "keyup",
    ])
      document.addEventListener(
        type,
        (event) => {
          const target = event.target;
          events.push({
            type,
            trusted: event.isTrusted,
            ...(event instanceof PointerEvent
              ? { pointerType: event.pointerType }
              : {}),
            ...(event instanceof KeyboardEvent ? { key: event.key } : {}),
            target:
              target instanceof Element
                ? (target.getAttribute("aria-label") ?? target.tagName)
                : null,
          });
        },
        true,
      );
  });
}

async function trustedEvents(page: Page): Promise<TrustedEvent[]> {
  return page.evaluate(
    () =>
      (window as Window & { __flatEnvelopeEvents?: TrustedEvent[] })
        .__flatEnvelopeEvents ?? [],
  );
}

async function attachProof(
  page: Page,
  info: TestInfo,
  name: string,
  observation: object,
) {
  await info.attach(`${name}-receipt`, {
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(observation, null, 2)),
  });
  await info.attach(`${name}-screenshot`, {
    contentType: "image/png",
    body: await page.screenshot(),
  });
}

test.describe("flat envelope acceptance", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("pointer drag saves once, undo restores, and draft cancellation is inert", async ({
    page,
    receipts,
  }, info) => {
    await withShareableProject(
      async (projectPath) => {
        const track = envelopeTrack(projectPath);
        const before = envelopeSnapshot(projectPath, track.id);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        await openFlatEnvelope(page, projectPath, receipts);
        await recordTrustedEvents(page);

        expect(envelopeSnapshot(projectPath, track.id)).toEqual(before);
        expect(observer.commands).toEqual([]);
        receipts.push({
          checkpoint: "visible-empty-envelope-is-unsaved",
          observation: {
            saved: envelopeSnapshot(projectPath, track.id),
            commands: observer.commands,
          },
        });

        const slider = page.locator(".lane-row").first().getByRole("slider", {
          name: "Envelope level",
          exact: true,
        });
        await expect(slider).toHaveAttribute("aria-valuenow", "1");
        const box = await slider.boundingBox();
        expect(box).not.toBeNull();
        const start = {
          x: box!.x + box!.width / 2,
          y: box!.y + box!.height / 2,
        };
        const deltaY = -24;
        const drag = acceptedEnvelopeCommand(page, "SetEnvelope", async () => {
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(start.x, start.y + deltaY, { steps: 6 });
          await page.mouse.up();
        });
        const { command, reply } = await drag;
        expect(observer.commands).toHaveLength(1);
        expect(command.payload.track_id).toBe(track.id);
        expect(command.payload.points).toHaveLength(2);
        const points = command.payload.points!;
        expect(points[0]!.time).toBe(0);
        expect(points[1]!.time).toBeGreaterThan(0);
        expect(points[0]!.value).toBeGreaterThan(1);
        expect(points[1]!.value).toBe(points[0]!.value);
        const saved = envelopeSnapshot(projectPath, track.id);
        expect(saved.points).toEqual(points);
        expectEnvelopeMutation(before, saved, track.id);
        const pointerEvents = await trustedEvents(page);
        expect(
          pointerEvents.filter((event) => event.type.startsWith("pointer")),
        ).not.toHaveLength(0);
        expect(
          pointerEvents
            .filter((event) => event.type.startsWith("pointer"))
            .every((event) => event.trusted),
        ).toBe(true);
        receipts.push({
          checkpoint: "trusted-pointer-flat-line-save",
          observation: { command, reply, saved, events: pointerEvents },
        });

        const undo = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/document/command" &&
            (response.request().postDataJSON() as { type?: string }).type ===
              "UndoHistory",
        );
        await slider.focus();
        await page.keyboard.press("ControlOrMeta+z");
        const undoResponse = await undo;
        expect(undoResponse.status()).toBe(200);
        await undoResponse.json();
        const restored = envelopeSnapshot(projectPath, track.id);
        expect(restored.points).toEqual(before.points);
        expect(restored.otherEnvelopes).toEqual(before.otherEnvelopes);
        expect(restored.unchanged).toEqual(before.unchanged);
        expect(observer.commands.map((item) => item.type)).toEqual([
          "SetEnvelope",
          "UndoHistory",
        ]);
        receipts.push({
          checkpoint: "one-normal-undo-restores-envelope",
          observation: { responseStatus: undoResponse.status(), restored },
        });

        await createMenuCancels(page, slider);
        expect(observer.commands.map((item) => item.type)).toEqual([
          "SetEnvelope",
          "UndoHistory",
        ]);
        const canceled = envelopeSnapshot(projectPath, track.id);
        expect(canceled.points).toEqual(before.points);
        expect(canceled.otherEnvelopes).toEqual(before.otherEnvelopes);
        expect(canceled.unchanged).toEqual(before.unchanged);
        await attachProof(page, info, "flat-envelope-pointer", {
          fixture: "wrapper-owned disposable copy",
          savedBefore: before,
          savedAfterCancel: canceled,
          commands: observer.commands,
          events: pointerEvents,
        });
        await observer.retain();
      },
      undefined,
      emptyEnvelopeProject,
    );
  });

  test("keyboard level adjustment commits one flat envelope without a click", async ({
    page,
    receipts,
  }, info) => {
    await withShareableProject(
      async (projectPath) => {
        const track = envelopeTrack(projectPath);
        const before = envelopeSnapshot(projectPath, track.id);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        await openFlatEnvelope(page, projectPath, receipts);
        await recordTrustedEvents(page);
        const slider = page.locator(".lane-row").first().getByRole("slider", {
          name: "Envelope level",
          exact: true,
        });
        await expect(slider).toBeVisible();
        await slider.focus();
        await expect(slider).toBeFocused();
        const { command, reply } = await acceptedEnvelopeCommand(
          page,
          "SetEnvelope",
          async () => {
            await page.keyboard.down("ArrowDown");
            await page.keyboard.up("ArrowDown");
          },
        );
        expect(observer.commands).toHaveLength(1);
        expect(command.payload.points).toHaveLength(2);
        expect(command.payload.points?.[0]?.value).toBe(0.99);
        expect(command.payload.points?.[1]?.value).toBe(0.99);
        const saved = envelopeSnapshot(projectPath, track.id);
        expect(saved.points).toEqual(command.payload.points);
        expectEnvelopeMutation(before, saved, track.id);
        const events = await trustedEvents(page);
        expect(
          events
            .filter((event) => event.key?.startsWith("Arrow"))
            .every((event) => event.trusted),
        ).toBe(true);
        expect(
          events.filter(
            (event) =>
              event.type === "keydown" && event.key?.startsWith("Arrow"),
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) => event.type === "keyup" && event.key?.startsWith("Arrow"),
          ),
        ).toHaveLength(1);
        expect(
          events.filter(
            (event) =>
              event.type === "click" && event.target === "Envelope level",
          ),
        ).toEqual([]);
        receipts.push({
          checkpoint: "trusted-keyboard-flat-line-save",
          observation: { command, reply, saved, events },
        });
        await createMenuCancels(page, slider);
        expect(observer.commands).toHaveLength(1);
        expect(envelopeSnapshot(projectPath, track.id)).toEqual(saved);
        await attachProof(page, info, "flat-envelope-keyboard", {
          savedBefore: before,
          savedAfterCancel: envelopeSnapshot(projectPath, track.id),
          commands: observer.commands,
          events,
        });
        await observer.retain();
      },
      undefined,
      emptyEnvelopeProject,
    );
  });
});

test.describe("flat envelope browser touch", () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    reducedMotion: "reduce",
  });
  test("trusted touch cancellation is inert and a released drag saves one flat envelope", async ({
    page,
    context,
    browserName,
    receipts,
  }, info) => {
    test.skip(
      browserName !== "chromium",
      "Chromium CDP touch input; no iOS claim",
    );
    await withShareableProject(
      async (projectPath) => {
        const track = envelopeTrack(projectPath);
        const before = envelopeSnapshot(projectPath, track.id);
        const observer = observeEnvelopeCommands(
          page,
          projectPath,
          track.id,
          receipts,
        );
        const cdp = await context.newCDPSession(page);
        try {
          await openFlatEnvelope(page, projectPath, receipts);
          await recordTrustedEvents(page);
          const slider = page
            .locator(".lane-row")
            .first()
            .getByRole("slider", { name: "Envelope level", exact: true });
          await expect(slider).toHaveAttribute("aria-valuenow", "1");
          const box = await slider.boundingBox();
          expect(box).not.toBeNull();
          const start = {
            x: box!.x + box!.width / 2,
            y: box!.y + box!.height / 2,
          };
          await touch(cdp, "touchStart", [start]);
          await expect(
            page
              .locator(".ui-toast")
              .filter({ hasText: "Envelope level armed:" }),
          ).toBeVisible();
          await touch(cdp, "touchMove", [{ x: start.x, y: start.y - 12 }]);
          await touch(cdp, "touchCancel");
          await expect(slider).toHaveAttribute("aria-valuenow", "1");
          expect(envelopeSnapshot(projectPath, track.id)).toEqual(before);
          expect(observer.commands).toEqual([]);
          const accepted = await acceptedEnvelopeCommand(
            page,
            "SetEnvelope",
            () =>
              touchDrag(
                cdp,
                page,
                start,
                { x: 0, y: -24 },
                { holdMs: LONG_PRESS_MS + 150 },
              ),
          );
          expect(observer.commands).toHaveLength(1);
          const saved = envelopeSnapshot(projectPath, track.id);
          expect(saved.points).toEqual(accepted.command.payload.points);
          expect(saved.points).toHaveLength(2);
          expect(saved.points[0]!.time).toBe(0);
          expect(saved.points[1]!.time).toBe(60);
          expect(saved.points[0]!.value).toBeGreaterThan(1);
          expect(saved.points[1]!.value).toBe(saved.points[0]!.value);
          expectEnvelopeMutation(before, saved, track.id);
          const events = await trustedEvents(page);
          const touchEvents = events.filter(
            (event) => event.pointerType === "touch",
          );
          expect(
            touchEvents.some((event) => event.type === "pointerdown"),
          ).toBe(true);
          expect(touchEvents.some((event) => event.type === "pointerup")).toBe(
            true,
          );
          const nativeTouchEvents = touchEvents.filter(
            (event) => event.trusted,
          );
          expect(
            nativeTouchEvents.some((event) => event.type === "pointerdown"),
          ).toBe(true);
          expect(
            nativeTouchEvents.some((event) => event.type === "pointerup"),
          ).toBe(true);
          expect(
            nativeTouchEvents.some((event) => event.type === "pointercancel"),
          ).toBe(true);
          receipts.push({
            checkpoint: "trusted-cdp-touch-flat-line",
            observation: {
              input: "Chromium CDP touch, not iOS simulator/device",
              before,
              saved,
              accepted,
              events: touchEvents,
              nativeTouchEvents,
            },
          });
          await attachProof(page, info, "flat-envelope-touch", {
            before,
            saved,
            accepted,
            events: touchEvents,
          });
        } finally {
          await observer.retain();
          if (!page.isClosed()) await cdp.detach();
        }
      },
      undefined,
      emptyEnvelopeProject,
    );
  });
});
