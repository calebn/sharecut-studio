import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT, srcRelative, walkTsFiles } from "./sourceFiles";
import {
  globPatterns,
  importsStorybook,
  isStoryOrTestFile,
  STORY_SUPPORT_MODULES,
  storyLeaks,
} from "./storyGovernance";

describe("storyLeaks", () => {
  it.each([
    ["App.tsx", 'import * as s from "./ui/Button.stories";', 1],
    ["App.tsx", 'const m = await import("./ui/Button.stories.tsx");', 1],
    ["App.tsx", 'export { default } from "./ui/Menu.stories";', 1],
    ["App.tsx", 'import { fn } from "storybook/test";', 1],
    ["App.tsx", 'import type { Meta } from "@storybook/react-vite";', 1],
    ["App.tsx", 'const s = require("storybook/test");', 1],
    ["App.tsx", 'const s = require("./ui/Button.stories");', 1],
    ["App.tsx", 'import Story = require("storybook/test");', 1],
    ["App.tsx", 'type Story = import("storybook/test").Mock;', 1],
    ["App.tsx", '// import "./ui/Button.stories";', 0],
    ["App.tsx", '/* require("storybook/test") */', 0],
    ["App.tsx", 'const example = `from "storybook/test"`;', 0],
    ["App.tsx", 'const example = "import storybook/test";', 0],
    [
      "App.tsx",
      'const url = "https://example.test/path"; import "storybook/test";',
      1,
    ],
    [
      "record/RecordApp.tsx",
      'import { recordStoryDecorator } from "./recordStoryDecorator";',
      1,
    ],
    [
      "App.tsx",
      'import { recordStoryDecorator } from "./record/recordStoryDecorator.tsx";',
      1,
    ],
    ["App.tsx", 'const m = import.meta.glob("./**/*.tsx");', 1],
    ["App.tsx", 'const m = import.meta.glob("./**/*.stories.tsx");', 1],
    ["App.tsx", 'const m = import.meta.glob<{ default: string }>("./a/*");', 1],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.tsx", "!**/*.stories.tsx"]);',
      0,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.tsx", "!./other/*.stories.tsx"]);',
      1,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.ts", "./**/*.tsx", "!**/*.stories.ts"]);',
      1,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.ts", "!**/*.stories.d.ts"]);',
      1,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*", "!**/*.stories.*"]);',
      0,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.{ts,tsx}", "!**/*.stories.@(ts|tsx)"]);',
      0,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob("./icons/*.svg", { eager: true });',
      0,
    ],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.ts?(x)", "!**/*.stories.ts"]);',
      1,
    ],
    ["App.tsx", 'const m = import.meta.glob("./**/*.[jt]s?(x)");', 1],
    ["App.tsx", '// import.meta.glob("./**/*.tsx")', 0],
    ["App.tsx", '/* import.meta.glob("./*.tsx") */', 0],
    ["App.tsx", "const example = \"import.meta.glob('./**/*.tsx')\";", 0],
    ["App.tsx", 'const example = `import.meta.glob("./**/*.tsx")`;', 0],
    [
      "App.tsx",
      'const m = import.meta.glob(["./**/*.ts?(x)", "!**/*.stories.{ts,tsx}"]);',
      0,
    ],
    [
      "App.tsx",
      'import { Button } from "./ui";\nimport "./styles/daw.css";\nimport {\n  a,\n} from "../x";',
      0,
    ],
    [
      "record/RecordApp.tsx",
      'import { makeComment } from "../test/fixtures";',
      1,
    ],
    ["App.tsx", 'import { f } from "./test";', 1],
    ["App.tsx", 'import { a } from "./ui/Button.test";', 1],
    ["App.tsx", 'import { t } from "./testing/util";', 0],
    ["App.tsx", 'import { x } from "./storybookHelpers";', 0],
    [
      "../vite.config.ts",
      'import { r } from "./src/record/recordStoryDecorator";',
      1,
    ],
    ["../vite.config.ts", 'import { m } from "./src/test/fixtures";', 1],
    ["../vite.config.ts", 'import { b } from "./src/ui/Button";', 0],
  ] as const)("%s / %s -> %i leaks", (rel, src, expected) => {
    expect(storyLeaks(rel, src)).toHaveLength(expected);
  });
});

it.each([
  ['// import.meta.glob("./**/*.tsx")', []],
  ["const example = \"import.meta.glob('./**/*.tsx')\";", []],
  ['const modules = import.meta.glob("./**/*.tsx");', [["./**/*.tsx"]]],
  [
    'const modules = import.meta.glob<{ default: string }>(["./**/*.ts", "!**/*.stories.ts"]);',
    [["./**/*.ts", "!**/*.stories.ts"]],
  ],
  [
    'const a = import.meta.glob("./a/*.tsx"); const b = import.meta.glob(["./b/*.ts", "!**/*.stories.ts"]);',
    [["./a/*.tsx"], ["./b/*.ts", "!**/*.stories.ts"]],
  ],
] as const)("extracts glob calls from syntax: %s", (source, expected) => {
  expect(globPatterns(source)).toEqual(expected);
});

it("classifies story, test and test-helper files", () => {
  expect(isStoryOrTestFile("ui/Button.stories.tsx")).toBe(true);
  expect(isStoryOrTestFile("record/LiveComments.stories.test.tsx")).toBe(true);
  expect(isStoryOrTestFile("ui/Button.test.tsx")).toBe(true);
  expect(isStoryOrTestFile("test/a11y.ts")).toBe(true);
  expect(isStoryOrTestFile("ui/Button.tsx")).toBe(false);
  expect(isStoryOrTestFile("record/recordStoryDecorator.tsx")).toBe(false);
});

describe("stories stay out of the production bundle", () => {
  it("app code never imports stories, Storybook, story support, or test-only modules", () => {
    const offenders: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = srcRelative(file);
      if (isStoryOrTestFile(rel) || STORY_SUPPORT_MODULES.has(rel)) {
        continue;
      }
      offenders.push(...storyLeaks(rel, readFileSync(file, "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the story-support allowlist real", () => {
    for (const rel of STORY_SUPPORT_MODULES) {
      expect(existsSync(join(SRC_ROOT, rel))).toBe(true);
      expect(importsStorybook(readFileSync(join(SRC_ROOT, rel), "utf8"))).toBe(
        true,
      );
    }
  });

  it("Storybook config globs stories from src", () => {
    const text = readFileSync(join(SRC_ROOT, "../.storybook/main.ts"), "utf8");
    expect(text).toContain('"../src/**/*.stories.@(ts|tsx)"');
  });

  it("Storybook preview themes docs pages and reuses applyTheme (#209)", () => {
    const text = readFileSync(
      join(SRC_ROOT, "../.storybook/preview.ts"),
      "utf8",
    );
    expect(text).toContain("container: StudioDocsContainer");
    expect(text).toContain("applyTheme(");
    expect(text).not.toContain('removeAttribute("data-theme")');
  });

  it("root build configs never import or glob stories", () => {
    const webRoot = join(SRC_ROOT, "..");
    const configs = readdirSync(webRoot).filter((name) =>
      /\.config\.[cm]?[jt]s$/.test(name),
    );
    expect(configs).toContain("vite.config.ts");
    const offenders = configs.flatMap((name) =>
      storyLeaks(`../${name}`, readFileSync(join(webRoot, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
