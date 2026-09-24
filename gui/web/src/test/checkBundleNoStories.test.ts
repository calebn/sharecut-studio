import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleStoryLeaks,
  storyMarkers,
} from "../../scripts/check-bundle-no-stories";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("production bundle story check", () => {
  it.each([
    ["ordinary app code", 'console.log("Sharecut Studio")', []],
    [
      "ordinary Storybook text",
      'console.log("Read the Storybook catalog")',
      [],
    ],
    ["story path", 'import("./Button.stories.tsx")', ["story file"]],
    ["extensionless story path", 'import("./Button.stories")', ["story file"]],
    [
      "scoped package",
      'import("@storybook/react-vite")',
      ["@storybook package"],
    ],
    ["unscoped package", 'import("storybook/test")', ["storybook package"]],
  ])("classifies %s", (_label, source, expected) => {
    expect(storyMarkers(source)).toEqual(expected);
  });

  it("scans nested JavaScript chunks and ignores other assets", () => {
    const dir = mkdtempSync(join(tmpdir(), "sharecut-bundle-check-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "storybook/test");
    writeFileSync(join(dir, "assets", "clean.js"), 'console.log("Storybook")');
    writeFileSync(
      join(dir, "assets", "leak.js"),
      'import("./Button.stories.tsx")',
    );
    expect(bundleStoryLeaks(dir)).toEqual(["assets/leak.js: story file"]);
  });
});
