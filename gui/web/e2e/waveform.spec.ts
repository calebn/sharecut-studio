import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { e2eProjectPath } from "./env";
import { withShareableProject } from "./shareableProject";
import { openGuestShare, openHostShare } from "./shareNavigation";
import {
  expectPaintedWaveformTile,
  rasterParity,
  waveformBackend,
} from "./waveformHook";

const thresholds = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "waveform-thresholds.json",
    ),
    "utf8",
  ),
) as {
  max_tile_response_bytes: number;
  tile_count_slop: number;
  max_full_audio_bytes: number;
};

/** Record waveform and audio traffic for one page. */
function watchWaveformTraffic(page: Page) {
  const seen = {
    tiles: [] as { url: string; bytes: number }[],
    pcm: 0,
    audioWindows: 0,
    fullAudio: 0,
  };
  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/waveform/tiles/")) {
      const body = await res.body().catch(() => Buffer.alloc(0));
      seen.tiles.push({ url, bytes: body.byteLength });
    }
    if (url.includes("/waveform/pcm/")) {
      seen.pcm += 1;
    }
    if (/\/api\/audio.*start_sec/.test(url)) {
      seen.audioWindows += 1;
    }
    if (url.includes("/api/audio") && !res.request().headers()["range"]) {
      const len = Number(res.headers()["content-length"] || 0);
      if (len > thresholds.max_full_audio_bytes) {
        seen.fullAudio += 1;
      }
    }
  });
  return seen;
}

test.describe("pyramid waveforms", () => {
  test("host draws tiles from the pyramid, never audio windows", async ({
    page,
    browserName,
  }) => {
    const seen = watchWaveformTraffic(page);
    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.locator(".daw-shell")).toBeVisible();
    await page.locator(".timeline-scroll").waitFor({ state: "visible" });

    const backend = await waveformBackend(page);
    if (browserName === "chromium") {
      expect(backend).toBe("webgl2");
      const parity = await rasterParity(page);
      expect(parity).not.toBeNull();
      expect(parity!).toBeLessThanOrEqual(2 / 255);
    } else {
      expect(["webgl2", "cpu-worker"]).toContain(backend);
    }
    await expectPaintedWaveformTile(page);

    // Deep zoom: tiles stay tile-sized and only the view (plus overscan) mounts.
    await page.locator(".timeline-scroll").click();
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("=");
    }
    await expectPaintedWaveformTile(page);
    const layout = await page.evaluate(() => {
      const view =
        (document.querySelector(".timeline-scroll") as HTMLElement | null)
          ?.clientWidth ?? 0;
      const layers = [...document.querySelectorAll(".clip-waveform")].map(
        (layer) =>
          [...layer.querySelectorAll("canvas.clip-waveform-tile")].map(
            (c) => c.getBoundingClientRect().width,
          ),
      );
      return { view, layers };
    });
    const maxTiles =
      Math.ceil((layout.view + 2 * 512) / 512) + thresholds.tile_count_slop;
    for (const widths of layout.layers) {
      expect(widths.length).toBeLessThanOrEqual(maxTiles);
      for (const w of widths) {
        expect(w).toBeLessThanOrEqual(512 + 1);
      }
    }

    expect(seen.tiles.length).toBeGreaterThan(0);
    for (const { bytes } of seen.tiles) {
      expect(bytes).toBeLessThanOrEqual(thresholds.max_tile_response_bytes);
    }
    expect(seen.audioWindows).toBe(0);
    expect(seen.fullAudio).toBe(0);
  });

  test("guest share draws tiles through the share route, with no PCM", async ({
    browser,
  }) => {
    await withShareableProject(async (projectPath) => {
      const hostContext = await browser.newContext();
      const guestContext = await browser.newContext();
      try {
        const host = await hostContext.newPage();
        await openHostShare(host, projectPath);
        const created = await host.request.post("/api/shares", {
          data: { path: projectPath, role: "viewer" },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const { share } = (await created.json()) as {
          share: { token: string };
        };

        const guest = await guestContext.newPage();
        const seen = watchWaveformTraffic(guest);
        await openGuestShare(guest, share.token);
        await expectPaintedWaveformTile(guest);
        expect(
          seen.tiles.some((t) =>
            t.url.includes(`/api/review/${share.token}/daw/waveform/tiles/`),
          ),
        ).toBe(true);
        expect(seen.tiles.every((t) => t.url.includes("/api/review/"))).toBe(
          true,
        );
        expect(seen.pcm).toBe(0);
        expect(seen.audioWindows).toBe(0);
      } finally {
        await guestContext.close();
        await hostContext.close();
      }
    });
  });
});
