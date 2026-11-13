import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../test/sourceFiles";
import { isStoryOrTestFile } from "../test/storyGovernance";

const HELPERS: ReadonlySet<string> = new Set([
  "utils/storage.ts",
  "utils/tabStorage.ts",
]);

/** Src-relative files allowed to touch storage directly. Must stay empty; adding an entry needs review. */
const ALLOWLIST: readonly string[] = [];

const STORAGE = /\b(?:localStorage|sessionStorage)\b/g;
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function isExempt(rel: string): boolean {
  return (
    HELPERS.has(rel) || isStoryOrTestFile(rel) || /(^|\/)storybook\//.test(rel)
  );
}

function storageUses(rel: string, text: string): number[] {
  let comments: { start: number; end: number }[];
  try {
    comments = parse(text, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    }).comments as { start: number; end: number }[];
  } catch (e) {
    throw new Error(`${rel}: cannot parse (${(e as Error).message})`);
  }
  const parts: string[] = [];
  let at = 0;
  for (const { start, end } of comments) {
    parts.push(
      text.slice(at, start),
      text.slice(start, end).replace(/[^\n]/g, " "),
    );
    at = end;
  }
  parts.push(text.slice(at));
  const code = parts.join("");
  return [...code.matchAll(STORAGE)].map(
    (m) => code.slice(0, m.index).split("\n").length,
  );
}

function offendersIn(
  dir?: string,
  scanned: string[] = [],
): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const { rel, text } of sourceFiles(dir, SOURCE_EXTENSIONS)) {
    scanned.push(rel);
    if (isExempt(rel)) {
      continue;
    }
    const lines = storageUses(rel, text);
    if (lines.length > 0) {
      found.set(rel, lines);
    }
  }
  return found;
}

let tree: { found: Map<string, number[]>; scanned: string[] } | undefined;
function offenders() {
  if (!tree) {
    const scanned: string[] = [];
    tree = { found: offendersIn(undefined, scanned), scanned };
  }
  return tree;
}

describe("storage guard", () => {
  it.each([
    ["localStorage.getItem('k')", 1],
    ["window.localStorage.setItem('k', 'v')", 1],
    ["globalThis.sessionStorage?.getItem('k')", 1],
    ["self.localStorage", 1],
    ["window['localStorage']", 1],
    ["const { sessionStorage } = window;", 1],
    ["// localStorage in a comment", 0],
    ["/* sessionStorage */ const a = 1;", 0],
    ["// see https://x.test/localStorage", 0],
    ["const u = 'https://x.test'; localStorage.clear();", 1],
    ["const g = './**/*.tsx'; localStorage.clear();", 1],
    ["const x = <div>{/* localStorage */}</div>;", 0],
    ["const readLocal = 1; const localStorageKey = 2;", 0],
  ])("scanning %j finds %i use(s)", (src, n) => {
    expect(storageUses("App.tsx", src)).toHaveLength(n);
  });

  it("allowlist is empty", () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it("scans the real tree, including .js worklets", () => {
    const { scanned } = offenders();
    expect(scanned.length).toBeGreaterThan(200);
    expect(scanned).toContain("record/keeper/keeperProcessor.js");
    expect(scanned).toContain("utils/storage.ts");
  });

  it("reports a planted violation and skips exempt files", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-guard-"));
    try {
      writeFileSync(join(dir, "bad.ts"), "\nwindow.localStorage.clear();\n");
      writeFileSync(join(dir, "x.test.ts"), "localStorage.clear();");
      writeFileSync(join(dir, "w.js"), "sessionStorage.clear();");
      const found = new Map(
        [...offendersIn(dir)].map(([rel, lines]) => [basename(rel), lines]),
      );
      expect(Object.fromEntries(found)).toEqual({ "bad.ts": [2], "w.js": [1] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("app code uses browser storage only through utils/storage.ts and utils/tabStorage.ts", () => {
    const bad = [...offenders().found].map(
      ([rel, lines]) => `  ${rel}:${lines.join(",")}`,
    );
    expect(
      bad,
      `Direct localStorage/sessionStorage use. Route it through readLocal/writeLocal/removeLocal (utils/storage.ts) or utils/tabStorage.ts instead:\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
