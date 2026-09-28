import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import {
  timelineLaneStoryDecorator,
  timelineMarkerStoryDecorator,
} from "./timelineLaneStoryDecorator";

const here = dirname(fileURLToPath(import.meta.url));

function source(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

type DecoratorArgs = Parameters<typeof timelineLaneStoryDecorator>;

function renderShell(parameters: Record<string, unknown>) {
  const Story = (() => (
    <span data-testid="story" />
  )) as unknown as DecoratorArgs[0];
  return render(
    <>
      {timelineLaneStoryDecorator(Story, {
        parameters,
      } as unknown as DecoratorArgs[1])}
    </>,
  );
}

function renderMarkerShell(
  parameters: Record<string, unknown>,
  args: Record<string, unknown> = {},
) {
  const Story = (() => (
    <span data-testid="story" />
  )) as unknown as DecoratorArgs[0];
  return render(
    <>
      {timelineMarkerStoryDecorator(Story, {
        parameters,
        args,
      } as unknown as DecoratorArgs[1])}
    </>,
  );
}

describe("timelineLaneStoryDecorator", () => {
  it("falls back to the default label for a blank lanePreviewLabel", () => {
    const { container } = renderShell({ lanePreviewLabel: "   " });
    expect(
      container.querySelector("main[aria-label='Timeline lane preview']"),
    ).not.toBeNull();
  });

  it("renders a single lane with no data-track-id and the default label", () => {
    const { container } = renderShell({});
    const rows = container.querySelectorAll(".lane-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hasAttribute("data-track-id")).toBe(false);
    expect((rows[0] as HTMLElement).style.width).toBe("40rem");
    expect(
      container.querySelector(".lane-inner [data-testid='story']"),
    ).not.toBeNull();
    expect(
      container.querySelector("main[aria-label='Timeline lane preview']"),
    ).not.toBeNull();
    expect(container.querySelector("[data-story-ruler-room]")).toBeNull();
  });

  it("renders one lane-row per laneTrackIds id, with the story only in the first", () => {
    const { container } = renderShell({
      laneTrackIds: ["a", "b"],
      lanePreviewLabel: "X preview",
    });
    const rows = container.querySelectorAll(".lane-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-track-id")).toBe("a");
    expect(rows[1]!.getAttribute("data-track-id")).toBe("b");
    expect(rows[1]!.childElementCount).toBe(0);
    expect(
      container.querySelector("main[aria-label='X preview']"),
    ).not.toBeNull();
  });

  it("uses 360px lanes at phone width", () => {
    const { container } = renderShell({
      phoneWidth: true,
      laneTrackIds: ["a", "b"],
    });
    const rows = [...container.querySelectorAll(".lane-row")] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.width).toBe("360px");
    }
  });

  it("reserves ruler room above the lanes when asked", () => {
    const { container } = renderShell({ reserveRulerRoom: true });
    const main = container.querySelector("main")!;
    const first = main.firstElementChild as HTMLElement;
    expect(first.hasAttribute("data-story-ruler-room")).toBe(true);
    expect(first.getAttribute("aria-hidden")).toBe("true");
    expect(first.style.height).toBe("var(--ruler-height)");
    const laneRow = main.querySelector(".lane-row");
    expect(
      first.compareDocumentPosition(laneRow!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("loads a positive --ruler-height into the Storybook preview", () => {
    // Play functions run under jsdom (allStories.test.tsx), which neither
    // loads the preview CSS nor lays out, so this guards the source chain.
    expect(source("../../.storybook/preview.ts")).toMatch(
      /^import\s+["']\.\.\/src\/styles\/daw\.css["'];?$/m,
    );
    expect(source("../styles/daw.css")).toMatch(
      /@import\s+(?:url\()?["']\.\/theme\.css["']/,
    );
    expect(source("../styles/theme.css")).toMatch(
      /@import\s+(?:url\()?["']\.\/theme\/tokens\.css["']/,
    );
    // Every declaration in any stylesheet (tokens, themes, partials, media
    // queries) stays a positive length, so no later rule can zero it.
    const stylesDir = join(here, "../styles");
    const declarations = readdirSync(stylesDir, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) =>
        [
          ...readFileSync(join(stylesDir, file), "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .matchAll(/--ruler-height\s*:\s*([^;}]+)/g),
        ].map((m) => ({ file, value: (m[1] ?? "").trim() })),
      );
    expect(declarations.length).toBeGreaterThan(0);
    for (const { file, value } of declarations) {
      const length = value.match(/^(\d+(?:\.\d+)?)(px|rem)$/);
      expect(length, `${file}: --ruler-height: ${value}`).not.toBeNull();
      expect(
        Number(length![1]),
        `${file}: --ruler-height: ${value}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("timelineMarkerStoryDecorator", () => {
  it("wraps the story in a marker shell with the default label and no lane rows", () => {
    const { container } = renderMarkerShell({});
    const main = container.querySelector("main.timeline-area") as HTMLElement;
    expect(main.getAttribute("aria-label")).toBe("Marker lane preview");
    expect(main.querySelector("[data-testid='story']")).not.toBeNull();
    expect(container.querySelector(".lane-row")).toBeNull();
    expect(main.style.getPropertyValue("--marker-row-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
    // No rows arg: all four marker rows are shown.
    expect(main.style.getPropertyValue("--marker-lane-height")).toBe(
      `${4 * MARKER_ROW_HEIGHT}px`,
    );
  });

  it("uses a lanePreviewLabel override and falls back on a blank one", () => {
    const { container, unmount } = renderMarkerShell({
      lanePreviewLabel: "Chapters preview",
    });
    expect(
      container.querySelector("main[aria-label='Chapters preview']"),
    ).not.toBeNull();
    unmount();
    const blank = renderMarkerShell({ lanePreviewLabel: " " });
    expect(
      blank.container.querySelector("main[aria-label='Marker lane preview']"),
    ).not.toBeNull();
  });

  it("sizes --marker-lane-height from a partial rows arg", () => {
    const { container } = renderMarkerShell(
      {},
      {
        rows: {
          chapters: true,
          social: false,
          comments: false,
          clipping: false,
        },
      },
    );
    const main = container.querySelector("main") as HTMLElement;
    expect(main.style.getPropertyValue("--marker-lane-height")).toBe(
      `${MARKER_ROW_HEIGHT}px`,
    );
  });
});
