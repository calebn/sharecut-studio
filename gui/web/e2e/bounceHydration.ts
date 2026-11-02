import fs from "node:fs";
import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { bouncedWavs } from "./exportFiles";
import { expectFitsViewport } from "./overlayReachability";
import { withShareableProject } from "./shareableProject";
import { deliverPage, goToStage, openProject } from "./stageNav";
import { setTheme, withAppearance } from "./theme";

async function geometry(page: Page) {
  return deliverPage(page).evaluate((element) => {
    const scroller = element as HTMLElement;
    const box = scroller.getBoundingClientRect();
    const rect = (selector: string) => {
      const node = scroller.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    return {
      scrollTop: scroller.scrollTop,
      clipTop: box.top + scroller.clientTop,
      clipBottom: box.top + scroller.clientTop + scroller.clientHeight,
      viewportHeight: innerHeight,
      focus: {
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent?.slice(0, 100),
      },
      running: rect('.sys-status[data-state="running"]'),
      transcript: rect(".dv-tx-preview"),
      anchorOverrides: Array.from(
        scroller.querySelectorAll<HTMLElement>("[style]"),
      )
        .filter((el) => el.style.getPropertyValue("overflow-anchor") !== "")
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          value: el.style.getPropertyValue("overflow-anchor"),
          priority: el.style.getPropertyPriority("overflow-anchor"),
        })),
    };
  });
}

async function fitsClip(page: Page, target: Locator): Promise<void> {
  await expectFitsViewport(page, target);
  await expect
    .poll(async () => {
      const box = await target.boundingBox();
      const clip = await geometry(page);
      return (
        !!box && box.y >= clip.clipTop && box.y + box.height <= clip.clipBottom
      );
    })
    .toBe(true);
}

async function captureAnchorEvents(page: Page) {
  return deliverPage(page).evaluateHandle((element) => {
    const scroller = element as HTMLElement;
    const stage = scroller.closest<HTMLElement>(".dv-stage")!;
    const records: Array<Record<string, unknown>> = [];
    let dropped = 0;
    const bindings: Array<{
      node: HTMLElement;
      type: string;
      listener: (event: Event) => void;
      capture: boolean;
    }> = [];
    const describe = (target: EventTarget | null) =>
      target instanceof Element
        ? {
            tag: target.tagName,
            class: target.getAttribute("class"),
            role: target.getAttribute("role"),
          }
        : null;
    const types = [
      "scroll",
      "pointerdown",
      "wheel",
      "touchstart",
      "keydown",
      "focusin",
      "focusout",
      "click",
    ];
    for (const [label, node] of [
      ["stage", stage],
      ["page", scroller],
    ] as const) {
      for (const capture of [true, false]) {
        for (const type of types) {
          const listener = (event: Event) => {
            if (records.length === 128) {
              dropped += 1;
              return;
            }
            records.push({
              at: performance.now(),
              eventTime: event.timeStamp,
              type: event.type,
              phase: event.eventPhase,
              listener: `${label}:${capture ? "capture" : "noncapture"}`,
              target: describe(event.target),
              currentTarget: describe(event.currentTarget),
              relatedTarget:
                event instanceof FocusEvent
                  ? describe(event.relatedTarget)
                  : null,
              inlineAnchors: Array.from(
                scroller.querySelectorAll<HTMLElement>("[style]"),
              )
                .filter((el) => el instanceof HTMLElement)
                .map((el) => ({
                  element: describe(el),
                  value: el.style.getPropertyValue("overflow-anchor"),
                  priority: el.style.getPropertyPriority("overflow-anchor"),
                }))
                .filter((style) => style.value !== ""),
            });
          };
          node.addEventListener(type, listener, { capture, passive: true });
          bindings.push({ node, type, listener, capture });
        }
      }
    }
    return {
      records,
      get dropped() {
        return dropped;
      },
      dispose: () => {
        for (const { node, type, listener, capture } of bindings)
          node.removeEventListener(type, listener, capture);
      },
    };
  });
}

export async function exerciseBounceHydration(
  page: Page,
  info: TestInfo,
  departure: boolean,
): Promise<void> {
  for (const { cell: width, theme, reducedMotion } of withAppearance([
    360, 390, 1280,
  ])) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await withShareableProject(async (projectPath) => {
      const phases: unknown[] = [];
      const stem = `issue-2298-bounce-${info.project.name || "chromium"}-${width}-${departure ? "departure" : "active"}-retry${info.retry}`;
      const folder = "playwright-report";
      fs.mkdirSync(folder, { recursive: true });
      let releasePreview = () => {};
      const previewHeld = new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
      let serverPreviewReady = false;
      let releaseBounce = () => {};
      const bounceHeld = new Promise<void>((resolve) => {
        releaseBounce = resolve;
      });
      let previewRequests = 0;
      let bounceRequests = 0;
      let allowJob = false;
      let abortedDuringCleanup = 0;
      let failure: string | null = null;
      let primaryError: unknown;
      let breakpointViewportChanged = false;
      let breakpointControl: Awaited<
        ReturnType<Locator["elementHandle"]>
      > | null = null;
      let eventLog: Awaited<ReturnType<typeof captureAnchorEvents>> | null =
        null;
      let nativeEventDiagnostics: unknown = null;
      const cleanupFailures: unknown[] = [];
      const captureErrors: string[] = [];
      await page.route("**/api/transcript/export", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        const body = route.request().postDataJSON();
        if (body.path !== projectPath || !body.dry_run || body.with_text)
          return route.continue();
        previewRequests += 1;
        const response = await route.fetch();
        serverPreviewReady = true;
        await previewHeld;
        await route.fulfill({ response });
      });
      await page.route("**/api/export/bounce", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        bounceRequests += 1;
        await bounceHeld;
        if (allowJob) await route.continue();
        else {
          abortedDuringCleanup += 1;
          await route.abort("aborted");
        }
      });
      try {
        await openProject(page, projectPath);
        await setTheme(page, theme);
        await goToStage(page, "deliver");
        const deliver = deliverPage(page);
        eventLog = await captureAnchorEvents(page);
        const bounceSection = deliver.getByRole("region", {
          name: "Bounce",
          exact: true,
        });
        const bounceHeightBefore = await bounceSection.evaluate(
          (el) => el.getBoundingClientRect().height,
        );
        const original = await deliver
          .getByRole("button", { name: "Bounce", exact: true })
          .elementHandle();
        expect(original).toBeTruthy();
        const initial = await geometry(page);
        phases.push({ phase: "before-start", geometry: initial });
        await deliver
          .getByRole("button", { name: "Bounce", exact: true })
          .click();
        const cancel = deliver.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        const reason = deliver.getByText(/The bounce is still starting/);
        await expect(deliver.getByText(/Starting bounce…/)).toBeVisible();
        await expect(
          deliver.getByRole("button", { name: "Bounce", exact: true }),
        ).toBeDisabled();
        await expect
          .poll(() =>
            bounceSection.evaluate((el) => el.getBoundingClientRect().height),
          )
          .toBeGreaterThan(bounceHeightBefore);
        expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
        expect(
          await cancel.evaluate(
            (el, original) =>
              !!(
                el.compareDocumentPosition(original!) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
            original,
          ),
        ).toBe(true);
        phases.push({
          phase: "running-row-inserted-before-retained-button",
          geometry: await geometry(page),
        });
        await fitsClip(page, cancel);
        await fitsClip(page, reason);
        await expect
          .poll(() =>
            deliver.evaluate(
              (el) => document.activeElement === el.closest(".dv-stage"),
            ),
          )
          .toBe(true);
        const afterInsertionFocus = await page.evaluateHandle(
          () => document.activeElement,
        );
        const transcript = deliver.getByRole("region", {
          name: "Transcript",
          exact: true,
        });
        const loadingHeight = await transcript.evaluate(
          (el) => el.getBoundingClientRect().height,
        );
        await expect.poll(() => serverPreviewReady).toBe(true);
        let reader: Locator | null = null;
        let readerBefore: number | null = null;
        const readerFocus = afterInsertionFocus;
        if (departure) {
          reader = deliver
            .getByRole("region", { name: "Chapters", exact: true })
            .getByRole("heading", {
              name: "Chapters",
              level: 2,
              exact: true,
            });
          const movement = await reader.evaluateHandle((el) => {
            const scroller = el.closest<HTMLElement>(".dv-page")!;
            const from = scroller.scrollTop;
            const requested = Math.max(
              0,
              Math.min(
                scroller.scrollHeight - scroller.clientHeight,
                from +
                  el.getBoundingClientRect().top -
                  scroller.getBoundingClientRect().top -
                  scroller.clientTop -
                  scroller.clientHeight / 2,
              ),
            );
            const state = {
              from,
              requested,
              ended: false,
              endpoints: [] as number[],
              supported: "onscrollend" in scroller,
              dispose: () => {},
            };
            const ended = () => {
              state.endpoints.push(scroller.scrollTop);
              if (Math.abs(scroller.scrollTop - requested) <= 1) {
                state.ended = true;
                state.dispose();
              }
            };
            state.dispose = () =>
              scroller.removeEventListener("scrollend", ended);
            scroller.addEventListener("scrollend", ended);
            scroller.scrollTop = requested;
            return state;
          });
          try {
            expect(await movement.evaluate((state) => state.supported)).toBe(
              true,
            );
            await expect
              .poll(() => movement.evaluate((state) => state.ended))
              .toBe(true);
            const observed = await movement.evaluate(
              ({ from, requested, ended, endpoints }) => ({
                from,
                requested,
                ended,
                endpoints,
              }),
            );
            expect(
              Math.abs(observed.endpoints.at(-1)! - observed.from),
            ).toBeGreaterThan(1);
            phases.push({
              phase: "meaningful-scroll-only-departure-native-scrollend",
              ...observed,
            });
          } finally {
            try {
              await movement.evaluate((state) => state.dispose());
              await movement.dispose();
            } catch (error) {
              cleanupFailures.push(error);
              captureErrors.push(
                `departure listener cleanup: ${String(error)}`,
              );
            }
          }
          await expect
            .poll(async () => (await geometry(page)).anchorOverrides)
            .toEqual([]);
          const readerBox = await reader.evaluate((el) =>
            el.getBoundingClientRect().toJSON(),
          );
          const clip = await geometry(page);
          expect(readerBox.top).toBeGreaterThanOrEqual(clip.clipTop);
          expect(readerBox.bottom).toBeLessThanOrEqual(clip.clipBottom);
          readerBefore = readerBox.top;
          phases.push({
            phase: "reader-scroll-only-departure-settled",
            readerTop: readerBefore,
            geometry: clip,
          });
        }
        releasePreview();
        await expect(
          transcript.getByRole("list", { name: "Transcript preview" }),
        ).toBeVisible();
        await expect
          .poll(() =>
            transcript.evaluate((el) => el.getBoundingClientRect().height),
          )
          .toBeGreaterThan(loadingHeight);
        phases.push({
          phase: "real-transcript-preview-hydrated",
          geometry: await geometry(page),
        });
        expect(
          await readerFocus.evaluate((el) => el === document.activeElement),
        ).toBe(true);
        if (reader) {
          await expect
            .poll(async () =>
              Math.abs(
                (await reader!.evaluate(
                  (el) => el.getBoundingClientRect().top,
                )) - readerBefore!,
              ),
            )
            .toBeLessThanOrEqual(1);
          await expect
            .poll(async () => (await geometry(page)).anchorOverrides)
            .toEqual([]);
        } else {
          await fitsClip(page, cancel);
          await fitsClip(page, reason);
        }
        expect(previewRequests).toBe(1);
        expect(bounceRequests).toBe(1);
        await page.screenshot({ path: path.join(folder, `${stem}.png`) });
        allowJob = true;
        releaseBounce();
        await expect(deliver).toContainText(
          "Bounced 1 file(s) to export/bounces/",
        );
        await expect.poll(() => bouncedWavs(projectPath)).toHaveLength(1);
        expect(bounceRequests).toBe(1);
        expect(previewRequests).toBe(1);
        phases.push({
          phase: "real-bounce-finished",
          geometry: await geometry(page),
        });
        if (departure) {
          const formats = transcript.getByRole("button", {
            name: "VTT",
            exact: true,
          });
          await formats.click();
          await expect(formats).toHaveAttribute("aria-pressed", "true");
          const selectedFormats = await transcript
            .getByRole("button", { pressed: true })
            .allTextContents();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Tab");
          const copy = transcript.getByRole("button", {
            name: "Copy text",
            exact: true,
          });
          await expect(copy).toBeFocused();
          breakpointControl = await copy.elementHandle();
          expect(breakpointControl).toBeTruthy();
          const oppositeWidth = width === 1280 ? 390 : 1280;
          breakpointViewportChanged = true;
          await page.setViewportSize({ width: oppositeWidth, height: 844 });
          await expect(deliver.locator("..")).toHaveAttribute(
            "data-layout",
            oppositeWidth === 1280 ? "desktop" : "phone",
          );
          await expect
            .poll(() =>
              deliver.evaluate(
                (el) => document.activeElement === el.closest(".dv-stage"),
              ),
            )
            .toBe(true);
          expect(
            await breakpointControl!.evaluate((el) => el.isConnected),
          ).toBe(false);
          await expect(
            deliver.getByRole("region", { name: "Transcript", exact: true }),
          ).toHaveCount(1);
          expect(
            await transcript
              .getByRole("button", { pressed: true })
              .allTextContents(),
          ).toEqual(selectedFormats);
          expect(previewRequests).toBe(1);
          expect(bounceRequests).toBe(1);
          phases.push({
            phase: "transcript-breakpoint-existing-stage-focus-recovery",
            oppositeWidth,
            selectedFormats,
            geometry: await geometry(page),
          });
          await page.screenshot({
            path: path.join(folder, `${stem}-breakpoint.png`),
          });
        }
      } catch (error) {
        failure =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        primaryError = error;
      } finally {
        if (eventLog) {
          try {
            nativeEventDiagnostics = await eventLog.evaluate((state) => {
              state.dispose();
              return { records: state.records, dropped: state.dropped };
            });
          } catch (error) {
            cleanupFailures.push(error);
            captureErrors.push(`event listener cleanup: ${String(error)}`);
          } finally {
            try {
              await eventLog.dispose();
            } catch (error) {
              cleanupFailures.push(error);
              captureErrors.push(`event handle cleanup: ${String(error)}`);
            }
          }
        }
        releasePreview();
        releaseBounce();
        try {
          await page.unrouteAll({ behavior: "wait" });
        } catch (error) {
          cleanupFailures.push(error);
          captureErrors.push(`route cleanup: ${String(error)}`);
        }
        if (failure) {
          try {
            await page.screenshot({
              path: path.join(folder, `${stem}-failure.png`),
            });
          } catch (error) {
            captureErrors.push(`failure screenshot: ${String(error)}`);
          }
        }
        if (breakpointControl) {
          try {
            await breakpointControl.dispose();
          } catch (error) {
            cleanupFailures.push(error);
            captureErrors.push(`breakpoint handle cleanup: ${String(error)}`);
            info.annotations.push({
              type: "cleanup-error",
              description: `breakpoint handle: ${String(error)}`,
            });
          }
        }
        if (breakpointViewportChanged) {
          try {
            await page.setViewportSize({ width, height: 844 });
          } catch (error) {
            cleanupFailures.push(error);
            captureErrors.push(
              `breakpoint viewport restoration: ${String(error)}`,
            );
            info.annotations.push({
              type: "cleanup-error",
              description: `breakpoint viewport: ${String(error)}`,
            });
          }
        }
        const receipt = {
          kind: "REAL_DELIVER_CONTROLLED_HYDRATION",
          workflowSha: process.env.GITHUB_SHA ?? null,
          project: info.project.name,
          retry: info.retry,
          width,
          theme,
          reducedMotion,
          departure,
          previewRequests,
          bounceRequests,
          allowJob,
          abortedDuringCleanup,
          failure,
          phases,
          nativeEventDiagnostics,
          captureErrors,
          nativeScrollbarProof: "not claimed; prior static drag unexercised",
          physicalDeviceOrAudioProof: "not claimed",
        };
        fs.writeFileSync(
          path.join(folder, `${stem}.json`),
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
        try {
          await info.attach(stem, {
            body: Buffer.from(JSON.stringify(receipt)),
            contentType: "application/json",
          });
        } catch (error) {
          cleanupFailures.push(error);
          captureErrors.push(`receipt attachment: ${String(error)}`);
          fs.writeFileSync(
            path.join(folder, `${stem}.json`),
            `${JSON.stringify(receipt, null, 2)}\n`,
          );
        }
      }
      if (failure !== null) throw primaryError;
      if (cleanupFailures.length) throw cleanupFailures[0];
    });
  }
}
