import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storyUrl } from "../e2e-storybook/storyUrl";

const storybookDir = path.join(__dirname, "..", "e2e-storybook");
const files = fs.readdirSync(storybookDir);
const specs = files.filter((name) => name.endsWith(".spec.ts"));
const read = (name: string) =>
  fs.readFileSync(path.join(storybookDir, name), "utf8");
const storyOpeners = files
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
  .filter((name) => name !== "storyUrl.ts" && read(name).includes("storyUrl("))
  .map((name) => `"./${name.replace(/\.ts$/, "")}"`);

describe("storyUrl", () => {
  it("keeps the Storybook a11y addon idle in the story frame", () => {
    expect(storyUrl("templates-trackmix--phone-360", { theme: "dark" })).toBe(
      "/iframe.html?id=templates-trackmix--phone-360&viewMode=story&globals=theme:dark;a11y.manual:!true",
    );
  });

  it("carries the docs view mode and the embed flag", () => {
    expect(
      storyUrl("molecules-menu--docs", { theme: "light", viewMode: "docs" }),
    ).toBe(
      "/iframe.html?id=molecules-menu--docs&viewMode=docs&globals=theme:light;a11y.manual:!true",
    );
    expect(
      storyUrl("templates-mobileshell--phone-360", {
        theme: "light",
        embed: false,
      }),
    ).toBe(
      "/iframe.html?id=templates-mobileshell--phone-360&viewMode=story&globals=theme:light;a11y.manual:!true&embed=false",
    );
  });
});

describe("Storybook specs", () => {
  it("find the specs under e2e-storybook", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  it.each(specs)("%s opens story frames only through storyUrl", (spec) => {
    const source = read(spec);
    expect(source).not.toContain("iframe.html");
  });

  it.each(specs)("%s scans with axe only on storyUrl pages", (spec) => {
    const source = read(spec);
    const scansWithAxe = /expectPageAxeClean|AxeBuilder/.test(source);
    const opensThroughStoryUrl =
      source.includes("storyUrl(") ||
      storyOpeners.some((opener) => source.includes(`from ${opener}`));
    if (scansWithAxe) expect(opensThroughStoryUrl).toBe(true);
  });
});
