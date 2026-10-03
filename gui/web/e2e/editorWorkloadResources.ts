import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EditorProfileReport } from "./editorProfileReport";

export async function workloadResources(
  projectPath: string,
  cold: boolean,
): Promise<NonNullable<EditorProfileReport["protocol"]["resources"]>> {
  const raw = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(projectPath), "benchmark-media.json"),
      "utf8",
    ),
  ) as {
    version: number;
    tone_seconds: number;
    tone_hz: number;
    tone_peak: number;
    source_duration_sec: number;
  };
  if (
    manifest.version !== 1 ||
    manifest.tone_hz !== 440 ||
    manifest.tone_peak !== 0.25 ||
    !Number.isFinite(manifest.tone_seconds) ||
    manifest.tone_seconds < 0 ||
    manifest.tone_seconds > raw.timeline.duration_sec ||
    manifest.source_duration_sec !== raw.timeline.duration_sec
  )
    throw new Error("Invalid audition resource manifest");
  const media = [];
  for (const track of raw.timeline.tracks) {
    const filename = path.resolve(path.dirname(projectPath), track.media.path);
    const fd = fs.openSync(filename, "r");
    const header = Buffer.alloc(44);
    fs.readSync(fd, header, 0, 44, 0);
    fs.closeSync(fd);
    if (
      header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 36, 40) !== "data"
    )
      throw new Error("Unsupported fixture WAV header");
    if (
      header.readUInt16LE(20) !== 1 ||
      header.readUInt16LE(22) !== 1 ||
      header.readUInt16LE(34) !== 16 ||
      header.readUInt32LE(24) !== 48000 ||
      header.readUInt32LE(28) !== 96000
    )
      throw new Error("Expected generated 48kHz mono 16-bit PCM");
    const bytes = fs.statSync(filename).size;
    if (bytes !== 44 + header.readUInt32LE(40))
      throw new Error("WAV payload size differs from header");
    const durationSec = header.readUInt32LE(40) / header.readUInt32LE(28);
    if (durationSec !== raw.timeline.duration_sec)
      throw new Error("Source clock differs from named fixture duration");
    const digest = createHash("sha256");
    let offset = 0;
    const zeroes = Buffer.alloc(65536);
    const toneEnd =
      44 + Math.round(manifest.tone_seconds * header.readUInt32LE(24)) * 2;
    for await (const data of fs.createReadStream(filename, {
      highWaterMark: zeroes.length,
    })) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      digest.update(chunk);
      const start = Math.max(0, 44 - offset),
        end = Math.min(chunk.length, toneEnd - offset);
      for (let i = start; i < end; i += 2) {
        const frame = (offset + i - 44) / 2;
        const expected = Math.round(
          manifest.tone_peak *
            32767 *
            Math.sin(
              (2 * Math.PI * manifest.tone_hz * frame) /
                header.readUInt32LE(24),
            ),
        );
        if (Math.abs(chunk.readInt16LE(i) - expected) > 1)
          throw new Error("Actual PCM differs from declared audition prefix");
      }
      const tail = chunk.subarray(Math.max(0, toneEnd - offset));
      if (tail.length && !tail.equals(zeroes.subarray(0, tail.length)))
        throw new Error("Declared sparse silent tail has nonzero PCM");
      offset += chunk.length;
    }
    media.push({
      ref: `track:${track.id}`,
      bytes,
      durationSec,
      auditionPrefixSec: manifest.tone_seconds,
      sha256: digest.digest("hex"),
    });
  }
  if (
    cold &&
    fs.existsSync(path.join(path.dirname(projectPath), "artifacts", "peaks")) &&
    fs
      .readdirSync(path.join(path.dirname(projectPath), "artifacts", "peaks"))
      .some((name) => name.endsWith(".wfpk"))
  )
    throw new Error("Cold workload has a prebuilt pyramid");
  return {
    waveforms: cold ? "empty-pyramid-cache" : "prebuilt",
    server: "fresh-process",
    browser: "fresh-context",
    osCache: "uncontrolled",
    media,
  };
}
