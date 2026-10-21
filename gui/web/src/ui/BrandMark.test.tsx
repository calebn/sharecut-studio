import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { BrandLockup, BrandSymbol } from "./BrandMark";
import { SYMBOL_PATHS, WORDMARK_GLYPHS } from "./brand/lockupGeometry";

const MASTER = readFileSync(
  join(import.meta.dirname, "../../../../deploy/brand/logo/logo-dark.svg"),
  "utf8",
);
const pathData = (svg: string): string[] =>
  [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1] as string);

describe("brand artwork", () => {
  it("draws exactly the approved master geometry", () => {
    expect(pathData(MASTER)).toEqual([
      ...SYMBOL_PATHS.map((path) => path.d),
      ...WORDMARK_GLYPHS.map((glyph) => glyph.d),
    ]);
  });

  it("names the product as text and hides the artwork from assistive tech", async () => {
    const { container } = render(
      <h1>
        <BrandLockup name="ShareCut Studio" />
      </h1>,
    );
    expect(
      screen.getByRole("heading", { name: "ShareCut Studio" }),
    ).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await expectNoA11yViolations(container);
  });

  it("keeps the symbol decorative", () => {
    const { container } = render(<BrandSymbol />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(container.querySelectorAll("path")).toHaveLength(4);
  });
});
