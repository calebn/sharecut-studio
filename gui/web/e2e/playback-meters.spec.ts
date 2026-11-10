import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { pcmWavHeader } from "../src/audio/wavHeader";
import { expectPageAxeClean } from "./axe";
import { pinFixedLaneHeight } from "./laneHeight";
import { createRelocatedE2eProject } from "./liveProject";
import { openPhoneTimeline } from "./phoneTimeline";
import { withShareableProject } from "./shareableProject";
import { openHostShare } from "./shareNavigation";
import { setAudition } from "./stageNav";
import { trackHeaderButton, trackHeaderOf } from "./trackHeader";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

type MeterSource = { rate: number; channels: number; wav: Buffer };
type MeterSources = Record<"reference" | "guest", MeterSource>;

const FIXTURE_SECONDS = 60;

function pcmWav(
  rate: number,
  channels: number,
  sampleAt: (frame: number, channel: number) => number,
): MeterSource {
  const frames = rate * FIXTURE_SECONDS;
  const samples = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      samples.writeInt16LE(
        Math.round(32767 * sampleAt(frame, channel)),
        (frame * channels + channel) * 2,
      );
    }
  }
  return {
    rate,
    channels,
    wav: Buffer.concat([
      Buffer.from(pcmWavHeader(samples.length, rate, channels)),
      samples,
    ]),
  };
}

function stereoTone(hot: boolean): MeterSource {
  const rate = 48000;
  return pcmWav(rate, 2, (frame, channel) => {
    const amplitude = hot ? (frame < rate * 2 ? 0.98 : 0.05) : 0.25;
    const frequency = hot ? 440 : 660;
    const sample =
      amplitude * Math.sin((2 * Math.PI * frequency * frame) / rate);
    return hot || channel === 0 ? sample : -sample;
  });
}

function createMeterProject(
  prefix: string,
  sources: MeterSources = {
    reference: stereoTone(true),
    guest: stereoTone(false),
  },
) {
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
    const source = sources[track.id === "guest" ? "guest" : "reference"];
    const media = object(track.media);
    media.channels = source.channels;
    media.sample_rate = source.rate;
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
    sources.reference.wav,
  );
  fs.writeFileSync(
    path.join(fixture.workspaceDir, "raw/guest.wav"),
    sources.guest.wav,
  );
  return fixture;
}

function createMixedRateProject(prefix: string) {
  return createMeterProject(prefix, {
    reference: pcmWav(48000, 2, () => 0),
    guest: pcmWav(
      8000,
      1,
      (frame) => 0.5 * Math.sin((2 * Math.PI * 440 * frame) / 8000),
    ),
  });
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

/** The header's avatar ring, drawn from the track's live level at about 8 Hz. */
async function ringLevel(header: Locator): Promise<number> {
  return Number(
    await header.evaluate((node) =>
      (node as HTMLElement).style.getPropertyValue("--sys-track-level"),
    ),
  );
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

/** A header holds its avatar and fits the lane-high slot it stands in, even in the shortest lane. */
async function expectHeaderContained(header: Locator) {
  const contained = await header.evaluate((element) => {
    const slot = element.closest(".track-column-row");
    const avatar = element.querySelector(".sys-track-avatar");
    if (!slot || !avatar) return false;
    const within = (inner: DOMRect, outer: DOMRect) =>
      inner.left >= outer.left - 0.5 &&
      inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 &&
      inner.bottom <= outer.bottom + 0.5;
    return (
      within(element.getBoundingClientRect(), slot.getBoundingClientRect()) &&
      within(avatar.getBoundingClientRect(), element.getBoundingClientRect())
    );
  });
  expect(contained).toBe(true);
}

/** The track's details hold its meter and clip light: the header shows the ring and a clipped badge. */
async function openReferenceDetails(page: Page) {
  if (await clearClip(page).isVisible()) return;
  await trackHeaderButton(page, "reference").click();
  await expect(clearClip(page)).toBeVisible();
}

async function closeTrackDetails(page: Page) {
  const close = page
    .getByRole("dialog")
    .filter({ has: clearClip(page) })
    .getByRole("button", { name: "Close", exact: true });
  await close.click();
  await expect(clearClip(page)).toBeHidden();
}

test("real premix exposes per-track peaks, clipping, and responsive controls", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180000);
  const hostContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const host = await hostContext.newPage();
  await pinFixedLaneHeight(host);
  try {
    await withShareableProject(
      async (projectPath) => {
        await renderPreview(host, projectPath);
        await openHostShare(host, projectPath);
        const reference = trackHeaderButton(host, "reference");
        const referenceHeader = trackHeaderOf(reference);
        const guestHeader = trackHeaderOf(trackHeaderButton(host, "guest"));
        await expect(referenceHeader).not.toHaveAttribute("data-clipped");
        await openReferenceDetails(host);
        await expect(clearClip(host)).toBeDisabled();
        await play(host);
        await expect(clearClip(host)).toBeEnabled();
        // The header ring follows each track's own peak while it plays.
        await expect.poll(() => ringLevel(guestHeader)).toBeGreaterThan(0.5);
        await expect(meter(host, "reference")).toHaveAttribute(
          "aria-valuetext",
          /Clipping/,
        );
        await expect(referenceHeader).toHaveAttribute("data-clipped", "true");
        await expect(reference).toHaveAccessibleDescription(
          /Clipped in playback/,
        );
        await pause(host);
        await expect(clearClip(host)).toBeEnabled();
        expect(await ringLevel(guestHeader)).toBe(0);
        await expect(referenceHeader).toHaveAttribute("data-clipped", "true");
        await clearClip(host).click({ timeout: 10000 });
        await expect(clearClip(host)).toBeDisabled();
        await expect(referenceHeader).not.toHaveAttribute("data-clipped");
        await expect(host.locator(".pill.audio-error")).toHaveCount(0);

        // A shared link has no timeline in the stage frame, so the guest-proxy
        // meters have no surface; the host's own track headers carry the rest.
        await reference.focus();
        await host.keyboard.press("Alt+-");
        await expect(host.locator(".timeline-area")).toHaveAttribute(
          "data-lane-density",
          "compact",
        );

        for (const viewport of [
          { name: "desktop", width: 1440, height: 900 },
          { name: "tablet", width: 1024, height: 768 },
          { name: "phone", width: 390, height: 844 },
        ]) {
          await host.setViewportSize(viewport);
          if (viewport.name === "phone") await openPhoneTimeline(host);
          await expect(referenceHeader).toBeVisible();
          await expectHeaderContained(referenceHeader);
          await expectHeaderContained(guestHeader);
          await openReferenceDetails(host);
          await expect(meter(host, "reference")).toBeVisible();
          const target = await clearClip(host).boundingBox();
          expect(target).not.toBeNull();
          const minimum = viewport.name === "phone" ? 44 : 24;
          expect(target?.width).toBeGreaterThanOrEqual(minimum);
          expect(target?.height).toBeGreaterThanOrEqual(minimum);
          await expectPageAxeClean(host, ".track-headers");
          await host.screenshot({
            path: testInfo.outputPath(`playback-meters-${viewport.name}.png`),
          });
          await closeTrackDetails(host);
        }
      },
      undefined,
      createMeterProject,
    );
  } finally {
    await hostContext.close();
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
        await openReferenceDetails(page);
        const header = trackHeaderOf(trackHeaderButton(page, "reference"));
        const fill = meter(page, "reference").locator(".ui-meter-fill");
        const before = await fill.getAttribute("style");
        await play(page);
        await expect(clearClip(page)).toBeEnabled();
        await expect(fill).toHaveAttribute("style", before ?? "");
        expect(await ringLevel(header)).toBe(0);
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

test("a mixed-rate raw guest keeps its own meter lit through a seek while a silent 48 kHz track stays dark", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await withShareableProject(
      async (projectPath) => {
        await openHostShare(page, projectPath);
        await setAudition(page, "raw");
        const guestHeader = trackHeaderOf(trackHeaderButton(page, "guest"));
        await play(page);
        await expect.poll(() => ringLevel(guestHeader)).toBeGreaterThan(0.1);
        expect(
          await ringLevel(trackHeaderOf(trackHeaderButton(page, "reference"))),
        ).toBe(0);
        const position = page.getByRole("slider", {
          name: "Timeline position",
        });
        await position.click({ position: { x: 600, y: 4 } });
        const seekedTo = Number(await position.getAttribute("aria-valuenow"));
        expect(seekedTo).toBeGreaterThan(30);
        await expect
          .poll(async () =>
            Number(await position.getAttribute("aria-valuenow")),
          )
          .toBeGreaterThan(seekedTo + 2);
        await expect.poll(() => ringLevel(guestHeader)).toBeGreaterThan(0.1);
      },
      undefined,
      createMixedRateProject,
    );
  } finally {
    await page.close();
  }
});
