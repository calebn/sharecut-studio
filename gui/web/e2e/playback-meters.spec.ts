import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { pcmWavHeader } from "../src/audio/wavHeader";
import { expectPageAxeClean } from "./axe";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import {
  createReviewShare,
  openGuestShare,
  openHostShare,
} from "./shareNavigation";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

function stereoTone(hot: boolean): Buffer {
  const rate = 48000;
  const frames = rate * 60;
  const samples = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    const amplitude = hot ? (frame < rate * 2 ? 0.98 : 0.05) : 0.25;
    const frequency = hot ? 440 : 660;
    const sample = Math.round(
      amplitude * 32767 * Math.sin((2 * Math.PI * frequency * frame) / rate),
    );
    samples.writeInt16LE(sample, frame * 4);
    samples.writeInt16LE(hot ? sample : -sample, frame * 4 + 2);
  }
  return Buffer.concat([
    Buffer.from(pcmWavHeader(samples.length, rate, 2)),
    samples,
  ]);
}

function createMeterProject(prefix: string) {
  const fixture = createRelocatedE2eProject(prefix);
  const parsed: unknown = JSON.parse(
    fs.readFileSync(fixture.projectPath, "utf8"),
  );
  const project = object(parsed);
  const timeline = object(project.timeline);
  if (!Array.isArray(timeline.tracks))
    throw new Error("Missing fixture tracks");
  timeline.tracks = timeline.tracks.map((value: unknown) => {
    const track = object(value);
    const media = object(track.media);
    media.channels = 2;
    media.sample_rate = 48000;
    track.media = media;
    track.gain_db = 0;
    track.muted = false;
    return track;
  });
  project.timeline = timeline;
  project.mix = { processing_chains: [], automation_envelopes: [] };
  project.render = {};
  fs.writeFileSync(
    fixture.projectPath,
    `${JSON.stringify(project, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(fixture.workspaceDir, "raw/reference.wav"),
    stereoTone(true),
  );
  fs.writeFileSync(
    path.join(fixture.workspaceDir, "raw/guest.wav"),
    stereoTone(false),
  );
  return fixture;
}

async function renderPreview(page: Page, projectPath: string) {
  const response = await page.request.post("/api/pipeline/render-preview", {
    data: { path: projectPath },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const started = object(await response.json());
  const jobId = object(started.job).id;
  expect(typeof jobId).toBe("string");
  await expect
    .poll(
      async () => {
        const status = await page.request.get("/api/pipeline/status");
        expect(status.ok(), await status.text()).toBeTruthy();
        const body = object(await status.json());
        const jobs = Array.isArray(body.jobs) ? body.jobs : [body.job];
        const job = jobs.map(object).find((entry) => entry.id === jobId);
        if (job?.status === "error" || job?.status === "cancelled") {
          throw new Error(JSON.stringify(job));
        }
        return job?.status;
      },
      { timeout: 60000 },
    )
    .toBe("ok");
}

function meter(page: Page, label: string): Locator {
  return page.getByRole("meter", { name: `${label} playback level` });
}

function clearClip(page: Page): Locator {
  return page.getByRole("button", { name: "Clear clip light for reference" });
}

async function play(page: Page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
}

async function pause(page: Page) {
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(meter(page, "reference")).toHaveAttribute(
    "aria-valuenow",
    "-60",
  );
}

async function expectContained(meterLocator: Locator) {
  const contained = await meterLocator.evaluate((element) => {
    const row = element.closest(".track-header-row");
    if (!row) return false;
    const outer = row.getBoundingClientRect();
    const inner = element.getBoundingClientRect();
    return (
      inner.left >= outer.left &&
      inner.right <= outer.right &&
      inner.top >= outer.top &&
      inner.bottom <= outer.bottom
    );
  });
  expect(contained).toBe(true);
}

test("real premix and guest proxy expose per-track peaks, clipping, and responsive controls", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180000);
  const hostContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const guestContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  try {
    await withShareableProject(
      async (projectPath) => {
        await renderPreview(host, projectPath);
        await openHostShare(host, projectPath);
        await expect(clearClip(host)).toBeDisabled();
        await play(host);
        await expect(clearClip(host)).toBeEnabled();
        await expect
          .poll(async () =>
            Number(await meter(host, "guest").getAttribute("aria-valuenow")),
          )
          .toBeGreaterThan(-20);
        await expect(meter(host, "reference")).toHaveAttribute(
          "aria-valuetext",
          /Clipping/,
        );
        await pause(host);
        await expect(clearClip(host)).toBeEnabled();
        await clearClip(host).click({ timeout: 10000 });
        await expect(clearClip(host)).toBeDisabled();
        await expect(host.locator(".pill.audio-error")).toHaveCount(0);

        const token = await createReviewShare(host, projectPath);
        await openGuestShare(guest, token);
        await play(guest);
        await expect(clearClip(guest)).toBeEnabled();
        // The mono guest proxy cancels this fixture's opposite-polarity channels.
        await expect(
          guest.locator(".track-playback-meter").nth(1),
        ).toHaveAttribute("data-available", "true");
        await expect(meter(guest, "guest")).toHaveAttribute(
          "aria-valuenow",
          "-60",
        );
        await pause(guest);
        await expect(clearClip(guest)).toBeEnabled();
        await guest
          .getByRole("button", { name: "Open track details, reference" })
          .focus();
        await guest.keyboard.press("Alt+-");
        await expect(guest.locator(".timeline-area")).toHaveAttribute(
          "data-lane-density",
          "compact",
        );

        for (const viewport of [
          { name: "desktop", width: 1440, height: 900 },
          { name: "tablet", width: 1024, height: 768 },
          { name: "phone", width: 390, height: 844 },
        ]) {
          await guest.setViewportSize(viewport);
          if (viewport.name === "phone") await openPhoneTimeline(guest);
          await expect(meter(guest, "reference")).toBeVisible();
          await expectContained(meter(guest, "reference"));
          const target = await clearClip(guest).boundingBox();
          expect(target).not.toBeNull();
          const minimum = viewport.name === "phone" ? 44 : 24;
          expect(target?.width).toBeGreaterThanOrEqual(minimum);
          expect(target?.height).toBeGreaterThanOrEqual(minimum);
          if (viewport.name === "phone") {
            const chip = await guest
              .locator(".track-header-row")
              .first()
              .locator(".track-chip")
              .boundingBox();
            expect(chip).not.toBeNull();
            expect(target?.y).toBeGreaterThanOrEqual(
              (chip?.y ?? 0) + (chip?.height ?? 0),
            );
          }
          await expectPageAxeClean(guest, ".track-headers");
          await guest.screenshot({
            path: testInfo.outputPath(`playback-meters-${viewport.name}.png`),
          });
        }
        await clearClip(guest).click({ timeout: 10000 });
        await expect(clearClip(guest)).toBeDisabled();
      },
      undefined,
      createMeterProject,
    );
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});

test("reduced motion freezes meter bars while real playback clipping remains detectable", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  try {
    await withShareableProject(
      async (projectPath) => {
        await renderPreview(page, projectPath);
        await openHostShare(page, projectPath);
        const fill = meter(page, "reference").locator(".ui-meter-fill");
        const before = await fill.getAttribute("style");
        await play(page);
        await expect(clearClip(page)).toBeEnabled();
        await expect(fill).toHaveAttribute("style", before ?? "");
        await expect(meter(page, "reference")).toHaveAttribute(
          "aria-valuenow",
          "-60",
        );
        await pause(page);
        await expect(clearClip(page)).toBeEnabled();
        await clearClip(page).click({ timeout: 10000 });
        await expect(clearClip(page)).toBeDisabled();
      },
      undefined,
      createMeterProject,
    );
  } finally {
    await page.close();
  }
});
