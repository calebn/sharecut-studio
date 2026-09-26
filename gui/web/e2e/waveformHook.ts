import { expect, type Page } from "@playwright/test";

/** What `window.__SHARECUT_E2E_WAVEFORM` exposes (E2E builds only). */
type WaveformHook = {
  backend: string;
  tilesRendered: number;
  tilesByMode: Record<"pyramid" | "pcm" | "line", number>;
  workerRestarts: number;
  rasterParity(): Promise<number | null>;
  crashWorker(): void;
};

type HookWindow = Window & { __SHARECUT_E2E_WAVEFORM?: WaveformHook };

/** The raster backend once the worker has reported (`webgl2`, `cpu-worker`, `none`). */
export async function waveformBackend(page: Page): Promise<string> {
  const area = page.locator(".timeline-area[data-waveform-backend]").first();
  await expect(area).not.toHaveAttribute("data-waveform-backend", "starting", {
    timeout: 15_000,
  });
  return (await area.getAttribute("data-waveform-backend")) ?? "";
}

/** GL vs CPU raster difference on a fixed tile (0..1), or null without WebGL2. */
export async function rasterParity(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      (window as HookWindow).__SHARECUT_E2E_WAVEFORM?.rasterParity() ?? null,
  );
}

/** Finished raster tiles since load, or -1 without the hook. */
export async function waveformTilesRendered(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as HookWindow).__SHARECUT_E2E_WAVEFORM?.tilesRendered ?? -1,
  );
}

/** Crash the raster worker on purpose; returns worker restarts since load. */
export async function crashWaveformWorker(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook = (window as HookWindow).__SHARECUT_E2E_WAVEFORM;
    hook?.crashWorker();
    return hook?.workerRestarts ?? -1;
  });
}

/** Finished raster tiles by mode since load (`pyramid`, `pcm`, `line`). */
export async function waveformTilesByMode(
  page: Page,
): Promise<Record<"pyramid" | "pcm" | "line", number> | null> {
  return page.evaluate(
    () => (window as HookWindow).__SHARECUT_E2E_WAVEFORM?.tilesByMode ?? null,
  );
}

/** True once some `canvas.clip-waveform-tile` holds painted pixels. */
export async function expectPaintedWaveformTile(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLCanvasElement>(
              "canvas.clip-waveform-tile",
            ),
          ].some((canvas) => {
            if (!canvas.width || !canvas.height) return false;
            const pixels = canvas
              .getContext("2d")
              ?.getImageData(0, 0, canvas.width, canvas.height).data;
            return pixels
              ? pixels.some((value, index) => index % 4 === 3 && value > 0)
              : false;
          }),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * Wait until waveform tiles stop changing: at least one tile has rendered
 * and the render count holds still for `quietMs`, then two frames so the
 * last bitmaps are drawn. Screenshot comparisons across a waveform need this.
 */
export async function waitForWaveformsSettled(
  page: Page,
  quietMs = 750,
): Promise<void> {
  const count = () => waveformTilesRendered(page);
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(0);
  let last = await count();
  let stableSince = Date.now();
  await expect
    .poll(
      async () => {
        const now = await count();
        if (now !== last) {
          last = now;
          stableSince = Date.now();
        }
        return Date.now() - stableSince >= quietMs;
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
