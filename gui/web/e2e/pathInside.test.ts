import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside } from "./pathInside";

describe("isPathInside", () => {
  const root = path.join(os.tmpdir(), "path-inside-root");

  it("is true for a direct child", () => {
    expect(isPathInside(root, path.join(root, "a"))).toBe(true);
  });

  it("is true for a nested descendant", () => {
    expect(isPathInside(root, path.join(root, "a", "b.wav"))).toBe(true);
  });

  it("is true for a child whose name starts with ..", () => {
    expect(isPathInside(root, path.join(root, "..foo"))).toBe(true);
  });

  it("is false for the root itself", () => {
    expect(isPathInside(root, root)).toBe(false);
  });

  it("is false for the parent via ..", () => {
    expect(isPathInside(root, path.join(root, ".."))).toBe(false);
  });

  it("is false for a sibling reached via ..", () => {
    expect(isPathInside(root, path.join(root, "..", "x"))).toBe(false);
  });

  it("is false when .. segments net out above the root", () => {
    expect(isPathInside(root, path.join(root, "a", "..", "..", "x"))).toBe(
      false,
    );
  });

  it("is false for a prefix-sharing sibling directory", () => {
    expect(isPathInside(root, `${root}2`)).toBe(false);
  });

  it("is false for a differently named sibling reached via ..", () => {
    expect(
      isPathInside(
        root,
        path.join(root, "..", "path-inside-root-sibling", "a"),
      ),
    ).toBe(false);
  });

  it("resolves a relative candidate against cwd", () => {
    expect(isPathInside(process.cwd(), "sub/file")).toBe(true);
  });
});
