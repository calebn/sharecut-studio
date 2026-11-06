import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { session } from "./prepareFixture";
import type { PrepareSource, SourceActions } from "./prepareTypes";
import { SessionSources } from "./SessionSources";

function actions(): SourceActions {
  return {
    onName: vi.fn(),
    onRemove: vi.fn(),
    onHear: vi.fn(),
    onVoices: vi.fn(),
    onSplit: vi.fn(),
    onCancelSplit: vi.fn(),
    onRetry: vi.fn(),
    onDetails: vi.fn(),
    onReplace: vi.fn(),
    onMerge: vi.fn(),
    onMove: vi.fn(),
    onReorder: vi.fn(),
    onDropAudio: vi.fn(),
  };
}

function source(id: string, state: PrepareSource["state"]): PrepareSource {
  return {
    id,
    state,
    name: "",
    fileName: `${id}.wav`,
    audioTime: "5:00 of audio",
    voices: 2,
    progress: 0.2,
    splitDetail: "1 of 9",
    cause: "Could not tell the voices apart.",
  };
}

describe("SessionSources routing", () => {
  it("hands each card's own id to Split, Cancel splitting and Try again", async () => {
    const handlers = actions();
    render(
      <SessionSources
        session={{
          ...session(),
          sources: [
            source("first", "split-prompt"),
            source("second", "split-prompt"),
            source("third", "splitting"),
            source("fourth", "failed"),
          ],
        }}
        firstIndex={1}
        actions={handlers}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Split voice 2" }),
    );
    expect(handlers.onSplit).toHaveBeenCalledWith("second");
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel splitting voice 3" }),
    );
    expect(handlers.onCancelSplit).toHaveBeenCalledWith("third");
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(handlers.onRetry).toHaveBeenCalledWith("fourth");
  });
});

describe("dragging a card to reorder", () => {
  const TOPS = [0, 100, 200];

  function layout() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const at = Number(this.dataset.at ?? "-1");
        const top = TOPS[at] ?? 0;
        return {
          top,
          bottom: top + 80,
          height: 80,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      },
    );
  }

  function renderThree(handlers: SourceActions) {
    const view = render(
      <SessionSources
        session={{
          ...session(),
          sources: [
            source("a", "ready"),
            source("b", "ready"),
            source("c", "ready"),
          ],
        }}
        firstIndex={1}
        actions={handlers}
      />,
    );
    view.container
      .querySelectorAll<HTMLElement>("[data-source-id]")
      .forEach((card, at) => {
        card.dataset.at = String(at);
      });
    return view;
  }

  const grips = (container: HTMLElement) =>
    container.querySelectorAll<HTMLElement>("[data-grip]");

  afterEach(() => vi.restoreAllMocks());

  it("moves the first card below the second and reports the card it took the place of", () => {
    layout();
    const handlers = actions();
    const { container } = renderThree(handlers);
    const grip = grips(container)[0]!;
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 150 });
    const cards = container.querySelectorAll<HTMLElement>("[data-source-id]");
    expect(cards[0]).toHaveAttribute("data-reordering", "true");
    expect(cards[0]!.style.getPropertyValue("--sys-source-shift")).toBe(
      "110px",
    );
    expect(cards[1]!.style.getPropertyValue("--sys-source-shift")).toBe(
      "-100px",
    );
    expect(cards[2]!.style.getPropertyValue("--sys-source-shift")).toBe("0px");
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 150 });
    expect(handlers.onReorder).toHaveBeenCalledWith("a", "b");
    expect(cards[0]).not.toHaveAttribute("data-reordering");
    expect(cards[0]!.style.getPropertyValue("--sys-source-shift")).toBe("");
  });

  it("moves a taller first card after the final shorter card", () => {
    const tops = [0, 260, 360];
    const heights = [240, 80, 80];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const at = Number(this.dataset.at ?? "-1");
        const top = tops[at] ?? 0;
        const height = heights[at] ?? 0;
        return {
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 300,
          width: 300,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      },
    );
    const handlers = actions();
    const { container } = renderThree(handlers);
    const grip = grips(container)[0]!;
    fireEvent.pointerDown(grip, { pointerId: 9, clientY: 20, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 9, clientY: 1000 });
    fireEvent.pointerUp(grip, { pointerId: 9, clientY: 1000 });
    expect(handlers.onReorder).toHaveBeenCalledExactlyOnceWith("a", "c");
  });

  it("moves the last card to the top", () => {
    layout();
    const handlers = actions();
    const { container } = renderThree(handlers);
    const grip = grips(container)[2]!;
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 240, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 5 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 5 });
    expect(handlers.onReorder).toHaveBeenCalledWith("c", "a");
  });

  it("changes nothing when dropped where it started, on Escape, or on a cancelled pointer", () => {
    layout();
    const handlers = actions();
    const { container } = renderThree(handlers);
    const grip = grips(container)[0]!;
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 40, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 50 });
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 50 });
    fireEvent.pointerDown(grip, { pointerId: 2, clientY: 40, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 2, clientY: 250 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(grip, { pointerId: 2, clientY: 250 });
    fireEvent.pointerDown(grip, { pointerId: 3, clientY: 40, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 3, clientY: 250 });
    fireEvent.pointerCancel(grip, { pointerId: 3 });
    expect(handlers.onReorder).not.toHaveBeenCalled();
    expect(
      container
        .querySelector<HTMLElement>("[data-source-id]")!
        .style.getPropertyValue("--sys-source-shift"),
    ).toBe("");
  });

  it("has no axe violations with grips on the cards", async () => {
    const { container } = renderThree(actions());
    expect(grips(container)).toHaveLength(3);
    await expectNoA11yViolations(container);
  });

  it("offers no grip on a lone card, and keeps the menu as the keyboard path", async () => {
    const handlers = actions();
    const lone = render(
      <SessionSources
        session={{ ...session(), sources: [source("a", "ready")] }}
        firstIndex={1}
        actions={handlers}
      />,
    );
    expect(grips(lone.container)).toHaveLength(0);
    lone.unmount();
    render(
      <SessionSources
        session={{
          ...session(),
          sources: [source("a", "ready"), source("b", "ready")],
        }}
        firstIndex={1}
        actions={handlers}
      />,
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: /^More for/ })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /^Move down/ }),
    );
    expect(handlers.onMove).toHaveBeenCalledWith("a", "down");
  });
});
