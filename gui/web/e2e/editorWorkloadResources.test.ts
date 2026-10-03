import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workloadResources } from "./editorWorkloadResources";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-media-test-"));
  roots.push(root);
  const pcm = Buffer.alloc(96000);
  for (let frame = 0; frame < 12000; frame++)
    pcm.writeInt16LE(
      Math.round(0.25 * 32767 * Math.sin((2 * Math.PI * 440 * frame) / 48000)),
      frame * 2,
    );
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const media = path.join(root, "source.wav");
  fs.writeFileSync(media, Buffer.concat([header, pcm]));
  const project = path.join(root, "episode.project.json");
  fs.writeFileSync(
    project,
    JSON.stringify({
      timeline: {
        duration_sec: 1,
        tracks: [{ id: "reference", media: { path: "source.wav" } }],
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, "benchmark-media.json"),
    JSON.stringify({
      version: 1,
      tone_seconds: 0.25,
      tone_hz: 440,
      tone_peak: 0.25,
      source_duration_sec: 1,
    }),
  );
  return { root, project, media };
}
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
describe("actual supplemental media provenance", () => {
  it("reports verified full-clock bytes and declared nonzero prefix", async () => {
    const { project } = fixture();
    const resource = await workloadResources(project, true);
    expect(resource.media[0]).toMatchObject({
      ref: "track:reference",
      bytes: 96044,
      durationSec: 1,
      auditionPrefixSec: 0.25,
    });
    expect(resource.media[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects incorrect declared PCM and a nonzero silent tail", async () => {
    for (const [offset, error] of [
      [44 + 10, "Actual PCM differs"],
      [44 + 48000, "silent tail has nonzero PCM"],
    ] as const) {
      const { project, media } = fixture();
      const bytes = fs.readFileSync(media);
      bytes.writeInt16LE(1234, offset);
      fs.writeFileSync(media, bytes);
      await expect(workloadResources(project, false)).rejects.toThrow(error);
    }
  });
  it("rejects shortened media and prebuilt pyramids in a cold workload", async () => {
    const { root, project, media } = fixture();
    fs.mkdirSync(path.join(root, "artifacts", "peaks"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "artifacts", "peaks", "existing.wfpk"),
      "pyramid",
    );
    await expect(workloadResources(project, true)).rejects.toThrow(
      "prebuilt pyramid",
    );
    const bytes = fs.readFileSync(media);
    bytes.writeUInt32LE(48000, 40);
    fs.writeFileSync(media, bytes.subarray(0, 48044));
    await expect(workloadResources(project, false)).rejects.toThrow(
      "Source clock differs",
    );
  });
});
