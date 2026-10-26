import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SYSTEM_ICON_NAMES } from "./icons";
import { SYSTEM_ICON_STROKE, SystemIcon } from "./SystemIcon";

const dir = dirname(fileURLToPath(import.meta.url));

describe("SystemIcon", () => {
  it.each(SYSTEM_ICON_NAMES)("renders the %s glyph", (name) => {
    const { container } = render(<SystemIcon name={name} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.children.length).toBeGreaterThan(0);
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

  it("matches the 20px set's on-screen stroke weight", () => {
    expect(SYSTEM_ICON_STROKE).toBeCloseTo((1.75 * 24) / 20, 5);
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
    const offenders = ["SystemIcon.tsx", "verbs.ts", "layout.ts"].filter(
      (file) => {
        try {
          return readFileSync(join(dir, file), "utf8").includes("lucide-react");
        } catch {
          return false;
        }
      },
    );
    expect(offenders).toEqual([]);
    expect(readFileSync(join(dir, "icons.ts"), "utf8")).not.toMatch(
      /import\s+\*\s+as/,
    );
  });
});
