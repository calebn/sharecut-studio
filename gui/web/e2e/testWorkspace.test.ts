import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { removeAfterTest, tempWorkspace } from "./testWorkspace";

describe("tempWorkspace", () => {
  let created = "";
  it("creates a prefixed directory under os.tmpdir()", () => {
    created = tempWorkspace("temp-workspace-test-");
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(path.dirname(created)).toBe(os.tmpdir());
    expect(path.basename(created)).toMatch(/^temp-workspace-test-/);
  });
  it("removes it after the test that created it", () => {
    expect(created).not.toBe("");
    expect(fs.existsSync(created)).toBe(false);
  });
});

describe("removeAfterTest", () => {
  let dir = "";
  it("returns the directory it registers", () => {
    const made = fs.mkdtempSync(path.join(os.tmpdir(), "remove-after-test-"));
    fs.writeFileSync(path.join(made, "f"), "x");
    dir = removeAfterTest(made);
    expect(dir).toBe(made);
    expect(fs.existsSync(dir)).toBe(true);
  });
  it("removes it recursively after that test", () => {
    expect(dir).not.toBe("");
    expect(fs.existsSync(dir)).toBe(false);
  });
});
