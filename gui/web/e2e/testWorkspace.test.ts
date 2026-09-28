import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { removeAfterTest, tempWorkspace } from "./testWorkspace";

/**
 * Assert `dir()` is gone once the test finishes. onTestFinished hooks run in
 * reverse registration order, so call this before the helper under test
 * registers its cleanup; this check then runs after that cleanup.
 */
function expectRemovedWhenTestFinishes(dir: () => string): void {
  onTestFinished(() => {
    expect(dir()).not.toBe("");
    expect(fs.existsSync(dir())).toBe(false);
  });
}

describe("tempWorkspace", () => {
  it("creates a prefixed directory under os.tmpdir() and removes it when the test finishes", () => {
    let created = "";
    expectRemovedWhenTestFinishes(() => created);
    created = tempWorkspace("temp-workspace-test-");
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(path.dirname(created)).toBe(os.tmpdir());
    expect(path.basename(created)).toMatch(/^temp-workspace-test-/);
  });
});

describe("removeAfterTest", () => {
  it("returns the directory and removes it recursively when the test finishes", () => {
    let dir = "";
    expectRemovedWhenTestFinishes(() => dir);
    const made = fs.mkdtempSync(path.join(os.tmpdir(), "remove-after-test-"));
    fs.writeFileSync(path.join(made, "f"), "x");
    dir = removeAfterTest(made);
    expect(dir).toBe(made);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
