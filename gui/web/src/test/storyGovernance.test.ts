import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT, srcRelative, walkTsFiles } from "./sourceFiles";
import {
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
      'import { Button } from "./ui";\nimport "./styles/daw.css";\nimport {\n  a,\n} from "../x";',
      0,
    ],
    ["App.tsx", 'import { x } from "./storybookHelpers";', 0],
  ] as const)("%s / %s -> %i leaks", (rel, src, expected) => {
    expect(storyLeaks(rel, src)).toHaveLength(expected);
  });
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
  it("app code never imports stories, Storybook, or story support", () => {
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

  it("only Storybook's config globs stories", () => {
    const text = readFileSync(join(SRC_ROOT, "../.storybook/main.ts"), "utf8");
    expect(text).toContain('"../src/**/*.stories.@(ts|tsx)"');
  });
});
