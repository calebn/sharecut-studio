import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storyUrl } from "../e2e-storybook/storyUrl";

const storybookDir = path.join(__dirname, "..", "e2e-storybook");
const specs = fs
  .readdirSync(storybookDir)
  .filter((name) => name.endsWith(".spec.ts"));

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
    const source = fs.readFileSync(path.join(storybookDir, spec), "utf8");
    expect(source).not.toContain("iframe.html");
  });

  it.each(specs)("%s scans with axe only on storyUrl pages", (spec) => {
    const source = fs.readFileSync(path.join(storybookDir, spec), "utf8");
    const scansWithAxe = /expectPageAxeClean|AxeBuilder/.test(source);
    if (scansWithAxe) expect(source).toContain("storyUrl(");
  });
});
