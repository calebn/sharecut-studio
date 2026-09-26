import {
  crashRasterWorker,
  getRasterBackend,
  type RasterBackendState,
  rasterParity,
  rasterTilesByMode,
  rasterTilesRendered,
  rasterWorkerRestarts,
  startRasterWorker,
} from "./rasterClient";
import type { RasterMode } from "./types";

/** Same gate as `record/monitor/e2eHook.ts`: tests and E2E builds only. */
export const WAVEFORM_E2E_BUILD =
  import.meta.env.MODE === "test" || import.meta.env.VITE_SHARECUT_E2E === "1";

export type WaveformE2eHook = {
  readonly backend: RasterBackendState;
  readonly tilesRendered: number;
  /** Finished tiles by raster mode (pyramid, pcm, line). */
  readonly tilesByMode: Readonly<Record<RasterMode, number>>;
  /** Raster worker restarts since load. */
  readonly workerRestarts: number;
  /** GL vs CPU difference on a fixed tile (0..1), or null without WebGL2. */
  rasterParity(): Promise<number | null>;
  /** Treat the raster worker as crashed, so it restarts. */
  crashWorker(): void;
};

/**
 * Expose `window.__SHARECUT_E2E_WAVEFORM` for Playwright. Production builds
 * drop the body (the gate is a build-time constant), and
 * `scripts/check-bundle-no-e2e.ts` fails the build if the name leaks.
 */
export function installWaveformE2eHook(
  target: Record<string, unknown> = window as unknown as Record<
    string,
    unknown
  >,
): void {
  if (WAVEFORM_E2E_BUILD) {
    startRasterWorker();
    const hook: WaveformE2eHook = {
      get backend() {
        return getRasterBackend();
      },
      get tilesRendered() {
        return rasterTilesRendered();
      },
      get tilesByMode() {
        return rasterTilesByMode();
      },
      get workerRestarts() {
        return rasterWorkerRestarts();
      },
      rasterParity,
      crashWorker: crashRasterWorker,
    };
    target.__SHARECUT_E2E_WAVEFORM = hook;
  }
}
