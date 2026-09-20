import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { e2eProjectPath, repoRoot } from "./env";

const thresholds = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "waveform-thresholds.json",
    ),
    "utf8",
  ),
) as {
  max_overview_bytes: number;
  max_full_audio_bytes: number;
  canvas_overscan_slop_px: number;
};

const guestTokensPath = path.join(
  repoRoot,
  "ux/assets/screens/.guest-tokens.json",
);

interface GuestTokens {
  daw_guest: { token: string };
}

function loadGuestTokens(): GuestTokens | null {
  if (!fs.existsSync(guestTokensPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(guestTokensPath, "utf8")) as GuestTokens;
}

test.describe("Zoom-matched waveforms", () => {
  test("host overview payload stays small; canvas is viewport-sized at max zoom", async ({
    page,
  }) => {
    const rangeAudio = { count: 0, fullFile: 0 };
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/audio") && !url.includes("start_sec")) {
        const range = res.request().headers()["range"];
        if (range) {
          rangeAudio.count += 1;
        }
        const len = Number(res.headers()["content-length"] || 0);
        if (!range && len > thresholds.max_full_audio_bytes) {
          rangeAudio.fullFile += 1;
        }
      }
    });

    await page.goto(`/?project=${encodeURIComponent(e2eProjectPath)}`);
    await expect(page.locator(".daw-shell")).toBeVisible();
    await page.locator(".timeline-scroll").waitFor({ state: "visible" });
    const peaksRes = await page.request.get(
      `/api/peaks/reference?path=${encodeURIComponent(e2eProjectPath)}`,
    );
    expect(peaksRes.ok()).toBe(true);
    const peakBody = await peaksRes.body();
    expect(peakBody.byteLength).toBeGreaterThan(0);
    expect(peakBody.byteLength).toBeLessThanOrEqual(
      thresholds.max_overview_bytes,
    );
    await expect(page.locator("canvas.clip-waveform").first()).toBeVisible();

    await page.locator(".timeline-scroll").click();
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("=");
    }
    await page.waitForTimeout(400);

    const canvasW = await page.evaluate(() => {
      const c = document.querySelector(
        "canvas.clip-waveform",
      ) as HTMLCanvasElement | null;
      return c?.getBoundingClientRect().width ?? 0;
    });
    const viewW = await page.evaluate(() => {
      const el = document.querySelector(
        ".timeline-scroll",
      ) as HTMLElement | null;
      return el?.clientWidth ?? 0;
    });
    expect(canvasW).toBeGreaterThan(0);
    expect(viewW).toBeGreaterThan(0);
    expect(canvasW).toBeLessThanOrEqual(
      viewW + thresholds.canvas_overscan_slop_px,
    );
    expect(rangeAudio.fullFile).toBe(0);
  });

  test("guest share overview stays overview-sized (no finest JSON)", async ({
    page,
  }) => {
    const tokens = loadGuestTokens();
    test.skip(
      !tokens,
      "Guest tokens from scripts/ux_demo_prepare_shares.py; pytest covers guest HTTP",
    );

    let hostWavRange = 0;
    page.on("response", (res) => {
      if (
        res.url().includes("/api/audio") &&
        !res.url().includes("/api/review/")
      ) {
        hostWavRange += 1;
      }
    });
    await page.goto(`/r/${tokens!.daw_guest.token}`);
    await expect(page.locator(".daw-shell-guest")).toBeVisible({
      timeout: 30_000,
    });
    const peaksRes = await page.request.get(
      `/api/review/${tokens!.daw_guest.token}/daw/peaks/reference`,
    );
    expect(peaksRes.ok()).toBe(true);
    const peakBody = await peaksRes.body();
    expect(peakBody.byteLength).toBeGreaterThan(0);
    expect(peakBody.byteLength).toBeLessThanOrEqual(
      thresholds.max_overview_bytes,
    );
    expect(hostWavRange).toBe(0);
  });
});
