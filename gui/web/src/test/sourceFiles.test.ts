import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SRC_ROOT, srcRelative, walkTsFiles } from "./sourceFiles";

describe("walkTsFiles", () => {
  let root = "";
  const listed = () =>
    walkTsFiles(root)
      .map((f) => f.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists ts/tsx files and skips node_modules and dist", () => {
    root = mkdtempSync(join(tmpdir(), "walk-ts-"));
    for (const d of ["a", "node_modules", "dist"]) {
      mkdirSync(join(root, d));
    }
    for (const f of [
      "a/x.ts",
      "a/y.tsx",
      "a/z.css",
      "node_modules/n.ts",
      "dist/d.ts",
    ]) {
      writeFileSync(join(root, f), "");
    }
    expect(listed()).toEqual(["a/x.ts", "a/y.tsx"]);
  });

  it("terminates on a symlinked directory cycle", () => {
    root = mkdtempSync(join(tmpdir(), "walk-ts-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "x.ts"), "");
    symlinkSync(root, join(root, "a", "loop"), "dir");
    expect(listed()).toEqual(["a/x.ts"]);
  });
});

it("srcRelative is forward-slashed and relative to src", () => {
  expect(srcRelative(join(SRC_ROOT, "record", "Declined.tsx"))).toBe(
    "record/Declined.tsx",
  );
});
