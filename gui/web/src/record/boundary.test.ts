import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const IMPORT =
  /(?:from\s+|import\s*\(\s*)["']((?:\.\.\/)+)record\/([^"']+)["']/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("record/ boundary", () => {
  it("is reached from the editor only through record/index.ts", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith("record/") || rel.startsWith("test/")) continue;
      if (rel === "api/sharesRecord.ts") continue;
      if (/\.(test|stories)\.tsx?$/.test(rel)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        offenders.push(`${rel} -> record/${match[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
