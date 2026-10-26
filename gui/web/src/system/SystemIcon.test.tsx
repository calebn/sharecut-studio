import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SYSTEM_ICON_NAMES } from "./icons";
import { DS_ICON_STROKE, SYSTEM_ICON_STROKE, SystemIcon } from "./SystemIcon";

const dir = dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(
  join(dir, "../../../../docs/design/stages/design-system.md"),
  "utf8",
);

const DRAWING = "path, circle, rect, line, polyline, polygon, ellipse, text";

describe("SystemIcon", () => {
  it.each(SYSTEM_ICON_NAMES)("renders the %s glyph", (name) => {
    const { container } = render(<SystemIcon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector(DRAWING)).not.toBeNull();
  });

  it("has no duplicate names", () => {
    expect(new Set(SYSTEM_ICON_NAMES).size).toBe(SYSTEM_ICON_NAMES.length);
  });

  it("is decorative unless it has a title", () => {
    const decorative = render(<SystemIcon name="scissors" />).container;
    expect(decorative.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    const named = render(<SystemIcon name="record" title="Record" />).container;
    const svg = named.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.querySelector("title")?.textContent).toBe("Record");
    const lucide = render(<SystemIcon name="ear" title="Hear" />).container;
    expect(lucide.querySelector("svg title")?.textContent).toBe("Hear");
  });

  it("keeps the stroke the design system names, scaled to Lucide's grid", () => {
    expect(spec).toMatch(new RegExp(`stroke ${DS_ICON_STROKE}[,)]`));
    expect(spec).toContain(
      `Decision (owner): \`SystemIcon\` stroke ${SYSTEM_ICON_STROKE}.`,
    );
  });

  it("applies the one exported stroke constant", () => {
    const { container } = render(<SystemIcon name="check" size={20} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("stroke-width")).toBe(String(SYSTEM_ICON_STROKE));
    expect(svg?.getAttribute("width")).toBe("20");
  });

  it("draws the progress ring from the progress prop", () => {
    const { container } = render(
      <SystemIcon name="progress-ring" progress={0.5} />,
    );
    const arc = container.querySelectorAll("circle")[1];
    const [filled, total] = (arc.getAttribute("stroke-dasharray") ?? "")
      .split(" ")
      .map(Number);
    expect(filled / total).toBeCloseTo(0.5, 5);
  });

  it("names lucide-react only in icons.ts, with named imports", () => {
    const files = readdirSync(dir).filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        file !== "icons.ts" &&
        file !== "SystemIcon.test.tsx",
    );
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((file) =>
      readFileSync(join(dir, file), "utf8").includes("lucide-react"),
    );
    expect(offenders).toEqual([]);
    expect(readFileSync(join(dir, "icons.ts"), "utf8")).not.toMatch(
      /import\s+\*\s+as/,
    );
  });
});
