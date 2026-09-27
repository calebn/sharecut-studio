import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { timelineLaneStoryDecorator } from "./timelineLaneStoryDecorator";

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

describe("timelineLaneStoryDecorator", () => {
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
    const laneRow = main.querySelector(".lane-row");
    expect(
      first.compareDocumentPosition(laneRow!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
