import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bounceDir, bouncedWavs } from "./exportFiles";
import { tempWorkspace } from "./testWorkspace";

describe("bounceDir", () => {
  it("is <project dir>/export/bounces", () => {
    expect(bounceDir("/w/episode.project.json")).toBe(
      path.join("/w", "export", "bounces"),
    );
  });
});

describe("bouncedWavs", () => {
  it("resolves to [] when the directory does not exist", async () => {
    const dir = tempWorkspace("bounce-files-");
    await expect(
      bouncedWavs(path.join(dir, "episode.project.json")),
    ).resolves.toEqual([]);
  });

  it("keeps only finished, non-hidden .wav files, sorted", async () => {
    const dir = tempWorkspace("bounce-files-");
    const bounces = bounceDir(path.join(dir, "episode.project.json"));
    fs.mkdirSync(bounces, { recursive: true });
    fs.writeFileSync(path.join(bounces, "b.wav"), "b");
    fs.writeFileSync(path.join(bounces, "a.wav"), "a");
    fs.writeFileSync(path.join(bounces, ".x.mix.wav"), "x");
    fs.writeFileSync(path.join(bounces, "a.mp3"), "a");
    fs.mkdirSync(path.join(bounces, ".y.stems"));
    await expect(
      bouncedWavs(path.join(dir, "episode.project.json")),
    ).resolves.toEqual([
      path.join(bounces, "a.wav"),
      path.join(bounces, "b.wav"),
    ]);
  });

  it("rejects when export/bounces is a file, not a directory", async () => {
    const dir = tempWorkspace("bounce-files-");
    fs.mkdirSync(path.join(dir, "export"), { recursive: true });
    fs.writeFileSync(path.join(dir, "export", "bounces"), "not a directory");
    await expect(
      bouncedWavs(path.join(dir, "episode.project.json")),
    ).rejects.toThrow();
  });
});
