import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  forbiddenStoryModule,
  forbidStoryModules,
} from "../../scripts/check-bundle-no-stories";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("production build story guard", () => {
  it.each([
    ["/app/src/ui/Button.stories.tsx", true],
    ["/app/src/ui/Button.stories.tsx?used", true],
    ["/app/node_modules/@storybook/react-vite/dist/index.js", true],
    ["/app/node_modules/storybook/test/index.js", true],
    ["/app/src/storybook/docsTheme.ts", true],
    ["/app/src/record/recordStoryDecorator.tsx", true],
    ["/app/src/ui/Button.tsx", false],
    ["/app/src/ui/StorybookLink.tsx", false],
  ])("classifies %s", (id, expected) => {
    expect(forbiddenStoryModule(id)).toBe(expected);
  });

  it.each([
    ["clean copy", 'console.log("Visit https://storybook/docs")', false],
    [
      "bundled story",
      'import { value } from "./Button.stories.js"; console.log(value)',
      true,
    ],
  ])("checks a real Vite build: %s", async (_label, source, fails) => {
    const dir = mkdtempSync(join(tmpdir(), "sharecut-story-build-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    writeFileSync(join(dir, "main.js"), source);
    if (fails)
      writeFileSync(join(dir, "Button.stories.js"), "export const value = 42;");

    const run = build({
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [forbidStoryModules()],
      build: { outDir: "dist" },
    });
    if (fails) {
      await expect(run).rejects.toThrow(
        "Production bundle includes story module",
      );
    } else {
      await expect(run).resolves.toBeDefined();
    }
  });
});
