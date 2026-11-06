import { describe, expect, it } from "vitest";
import { projectFolderOf } from "./projectFolder";

describe("projectFolderOf", () => {
  it("drops the entry file from an episode's path", () => {
    expect(projectFolderOf("/Users/maya/ShareCut/Ep 14/episode.sharecut")).toBe(
      "/Users/maya/ShareCut/Ep 14",
    );
  });

  it("keeps a folder path as it is", () => {
    expect(projectFolderOf("/Users/maya/ShareCut/Ep 14")).toBe(
      "/Users/maya/ShareCut/Ep 14",
    );
  });
});

describe("projectFolderOf on a share link", () => {
  it("has no folder to show", () => {
    expect(projectFolderOf("share:fantastic-acoustic-whale")).toBeUndefined();
  });
});
