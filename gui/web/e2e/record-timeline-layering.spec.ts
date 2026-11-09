import fs from "node:fs";
import {
  expect,
  type Page,
  type TestInfo,
  test,
  type WebSocketRoute,
} from "@playwright/test";
import { CHROMIUM_FAKE_MEDIA_ARGS } from "./launchOptions";
import { read } from "./lifecycleAudit";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openProject } from "./stageNav";
import { setTheme, type Theme } from "./theme";

test.use({ launchOptions: { args: [...CHROMIUM_FAKE_MEDIA_ARGS] } });

const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone-360", width: 360, height: 800 },
  { name: "phone-390", width: 390, height: 844 },
] as const;

function chapterProject(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const project = read(fixture.projectPath);
  project.editorial.chapters = [{ time: 0, title: "Existing chapter" }];
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  return fixture;
}

async function probeBandPaintOrder(page: Page) {
  return page.locator(".recording-overlay").evaluate((overlay) => {
    const band = overlay.querySelector<HTMLElement>(".recording-overlay-band");
    const marker = document.querySelector<HTMLElement>(
      '.sys-marker[data-kind="chapter"] .sys-marker-hit',
    );
    if (!band || !marker)
      throw new Error("recording band or chapter marker is missing");

    const bandRect = band.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const left = Math.max(bandRect.left, markerRect.left, 0);
    const right = Math.min(bandRect.right, markerRect.right, window.innerWidth);
    const top = Math.max(bandRect.top, markerRect.top, 0);
    const bottom = Math.min(
      bandRect.bottom,
      markerRect.bottom,
      window.innerHeight,
    );
    if (right <= left || bottom <= top) {
      return { intersects: false, bandWins: false, overlayPointerEvents: "" };
    }

    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const originalValue = band.style.getPropertyValue("pointer-events");
    const originalPriority = band.style.getPropertyPriority("pointer-events");
    let hit: Element | null = null;
    try {
      band.style.setProperty("pointer-events", "auto");
      hit = document.elementFromPoint(x, y);
    } finally {
      if (originalValue) {
        band.style.setProperty(
          "pointer-events",
          originalValue,
          originalPriority,
        );
      } else {
        band.style.removeProperty("pointer-events");
      }
    }

    return {
      intersects: true,
      bandWins: hit === band || band.contains(hit),
      overlayPointerEvents: getComputedStyle(overlay).pointerEvents,
      bandPointerEvents: getComputedStyle(band).pointerEvents,
    };
  });
}

async function compareMarkerOcclusion(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const crop = await page
    .locator(".recording-overlay-band")
    .evaluate((band) => {
      const title = document.querySelector<HTMLElement>(
        '.sys-marker[data-kind="chapter"] .sys-marker-title',
      );
      const marker = title?.closest<HTMLElement>(".sys-marker-hit");
      if (!title || !marker) throw new Error("chapter marker title is missing");

      const bandRect = band.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const left = Math.ceil(Math.max(bandRect.left, titleRect.left, 0)) + 1;
      const top = Math.ceil(Math.max(bandRect.top, titleRect.top, 0)) + 1;
      const right =
        Math.floor(
          Math.min(bandRect.right, titleRect.right, window.innerWidth),
        ) - 1;
      const bottom =
        Math.floor(
          Math.min(bandRect.bottom, titleRect.bottom, window.innerHeight),
        ) - 1;
      if (right <= left || bottom <= top) {
        throw new Error("chapter title does not intersect the band interior");
      }
      return {
        left,
        top,
        width: right - left,
        height: bottom - top,
        markerValue: marker.style.getPropertyValue("visibility"),
        markerPriority: marker.style.getPropertyPriority("visibility"),
      };
    });
  const clip = {
    x: crop.left,
    y: crop.top,
    width: crop.width,
    height: crop.height,
  };
  const marker = page.locator(
    '.sys-marker[data-kind="chapter"] .sys-marker-hit',
  );
  const visible = await page.screenshot({ clip, animations: "disabled" });
  let hidden: Buffer;
  try {
    await marker.evaluate((element) => {
      element.style.setProperty("visibility", "hidden");
    });
    hidden = await page.screenshot({ clip, animations: "disabled" });
  } finally {
    await marker.evaluate(
      (element, { value, priority }) => {
        if (value) element.style.setProperty("visibility", value, priority);
        else element.style.removeProperty("visibility");
      },
      { value: crop.markerValue, priority: crop.markerPriority },
    );
  }

  const pixels = await page.evaluate(
    async ({ visiblePng, hiddenPng }) => {
      const decode = (png: string) =>
        new Promise<ImageData>((resolve, reject) => {
          const image = new Image();
          image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            if (!context) {
              reject(new Error("canvas 2d context is unavailable"));
              return;
            }
            context.drawImage(image, 0, 0);
            resolve(context.getImageData(0, 0, canvas.width, canvas.height));
          };
          image.onerror = () =>
            reject(new Error("screenshot PNG did not decode"));
          image.src = `data:image/png;base64,${png}`;
        });
      const [visibleImage, hiddenImage] = await Promise.all([
        decode(visiblePng),
        decode(hiddenPng),
      ]);
      if (
        visibleImage.width !== hiddenImage.width ||
        visibleImage.height !== hiddenImage.height
      ) {
        throw new Error("occlusion screenshots have different dimensions");
      }
      let differingPixels = 0;
      for (let index = 0; index < visibleImage.data.length; index += 4) {
        if (
          visibleImage.data[index] !== hiddenImage.data[index] ||
          visibleImage.data[index + 1] !== hiddenImage.data[index + 1] ||
          visibleImage.data[index + 2] !== hiddenImage.data[index + 2] ||
          visibleImage.data[index + 3] !== hiddenImage.data[index + 3]
        ) {
          differingPixels += 1;
        }
      }
      return {
        differingPixels,
        totalPixels: visibleImage.width * visibleImage.height,
      };
    },
    {
      visiblePng: visible.toString("base64"),
      hiddenPng: hidden!.toString("base64"),
    },
  );
  return { ...pixels, width: crop.width, height: crop.height };
}

for (const viewport of viewports) {
  for (const theme of ["light", "dark"] as const satisfies readonly Theme[]) {
    test(`recording band paints above chapter markers at ${viewport.name} in ${theme}`, async ({
      page,
    }, testInfo: TestInfo) => {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });

      await withShareableProject(
        async (projectPath) => {
          let snapshot = {
            session_id: "record-overlay-layering",
            state: "lobby",
            take_index: 2,
            recording_ms: 60_000,
            timeline_start_sec: 0,
            server_time_ns: 1,
            participants: [],
            caps: { recorded: 4, producers: 2 },
          };
          await page.route(
            (url) => url.pathname === "/api/record/state",
            (route) => route.fulfill({ json: snapshot }),
          );
          let socket: WebSocketRoute | undefined;
          let connected = false;
          await page.routeWebSocket(/\/api\/host\/ws/, (route) => {
            socket = route;
            const server = route.connectToServer();
            server.onMessage((message) => {
              const payload = JSON.parse(String(message)) as { plane?: string };
              if (payload.plane === "record") return;
              route.send(message);
              if (payload.plane === "session") connected = true;
            });
          });

          await openProject(page, projectPath);
          if (viewport.name.startsWith("phone")) await openPhoneTimeline(page);
          await setTheme(page, theme);
          await expect(page.locator(".timeline-time")).toBeVisible();
          await expect(
            page.getByRole("button", { name: /^Chapter Existing chapter/ }),
          ).toBeVisible();
          await expect.poll(() => Boolean(socket) && connected).toBe(true);

          const send = (state: string, serverTime: number) => {
            snapshot = { ...snapshot, state, server_time_ns: serverTime };
            socket!.send(
              JSON.stringify({ plane: "record", type: "Snapshot", snapshot }),
            );
          };
          const overlay = page.getByRole("img", {
            name: /provisional recording/,
          });
          const band = page.locator(".recording-overlay-band");

          send("recording", 2);
          await expect(overlay).toHaveAttribute("data-state", "recording");
          await expect(band).toHaveText("Recording · Take 3");
          await expect(page.locator(".clip-block").first()).toBeVisible();
          const recordingProbe = await probeBandPaintOrder(page);
          const recordingPixels = await compareMarkerOcclusion(page);
          await page.screenshot({
            path: testInfo.outputPath(`${theme}-recording.png`),
          });

          send("paused", 3);
          await expect(overlay).toHaveAttribute("data-state", "paused");
          await expect(band).toHaveText("Paused · Take 3");
          const pausedProbe = await probeBandPaintOrder(page);
          const pausedPixels = await compareMarkerOcclusion(page);
          await page.screenshot({
            path: testInfo.outputPath(`${theme}-paused.png`),
          });

          send("stopped", 4);
          await expect(overlay).toHaveCount(0);
          for (const probe of [recordingProbe, pausedProbe]) {
            expect(
              probe.intersects,
              "the band and chapter marker overlap",
            ).toBe(true);
            expect(probe.bandWins, "the band is topmost at the overlap").toBe(
              true,
            );
            expect(probe.overlayPointerEvents).toBe("none");
            expect(probe.bandPointerEvents).toBe("none");
          }
          await testInfo.attach("occlusion-pixels.json", {
            body: JSON.stringify({
              method: "strict RGBA equality on decoded Chromium PNG crops",
              limits:
                "same-browser occlusion proof; not a cross-browser contrast measure",
              recording: recordingPixels,
              paused: pausedPixels,
            }),
            contentType: "application/json",
          });
          expect(
            {
              recording: recordingPixels.differingPixels,
              paused: pausedPixels.differingPixels,
            },
            `decoded ${recordingPixels.width}x${recordingPixels.height} PNG crop pixel differences; strict RGBA equality in Chromium, not a cross-browser contrast measure`,
          ).toEqual({ recording: 0, paused: 0 });
        },
        undefined,
        chapterProject,
      );
    });
  }
}
