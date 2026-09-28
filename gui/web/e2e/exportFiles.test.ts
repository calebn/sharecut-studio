import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bounceDir, bouncedWavs } from "./exportFiles";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

function workspace(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "bounce-files-"));
  workspaces.push(value);
  return value;
}

describe("bounceDir", () => {
  it("is <project dir>/export/bounces", () => {
    expect(bounceDir("/w/episode.project.json")).toBe(
      path.join("/w", "export", "bounces"),
    );
  });
});

describe("bouncedWavs", () => {
  it("resolves to [] when the directory does not exist", async () => {
    const dir = workspace();
    await expect(
      bouncedWavs(path.join(dir, "episode.project.json")),
    ).resolves.toEqual([]);
  });

  it("keeps only finished, non-hidden .wav files, sorted", async () => {
    const dir = workspace();
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
    const dir = workspace();
    fs.mkdirSync(path.join(dir, "export"), { recursive: true });
    fs.writeFileSync(path.join(dir, "export", "bounces"), "not a directory");
    await expect(
      bouncedWavs(path.join(dir, "episode.project.json")),
    ).rejects.toThrow();
  });
});
