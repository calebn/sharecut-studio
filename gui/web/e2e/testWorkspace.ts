import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

/** Remove `dir` recursively when the current Vitest test finishes; returns `dir`. Call inside a test. */
export function removeAfterTest(dir: string): string {
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A fresh `os.tmpdir()/<prefix>XXXXXX` directory, removed when the current Vitest test finishes. Call inside a test. */
export function tempWorkspace(prefix: string): string {
  return removeAfterTest(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
