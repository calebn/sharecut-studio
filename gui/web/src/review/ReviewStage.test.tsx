import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QUEUE_ITEMS, reviewContent } from "../storybook/reviewFixtures";
import { ReviewStage, type ReviewStageProps } from "./ReviewStage";

const NO_CHECK = QUEUE_ITEMS.filter((i) => i.id !== "c1" && i.id !== "u1");

function setup(props: Partial<ReviewStageProps> = {}) {
  const view = render(
    <ReviewStage
      initialItems={NO_CHECK}
      content={reviewContent}
      duration={3000}
      toastMs={600_000}
      initialSelectedId="f1"
      {...props}
    />,
  );
  const stage = view.container.querySelector(".rv-stage") as HTMLElement;
  const decided = () => screen.getByText(/of \d+ decided/).textContent;
  return { stage, decided, ...view };
}

describe("ReviewStage", () => {
  it("decides with Enter and advances in the same frame", () => {
    const { stage, decided } = setup();
    const before = decided();
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(decided()).not.toBe(before);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("applies the group with Shift+Enter as one undo step, skipping unsure cuts", async () => {
    const { stage, decided } = setup();
    const before = decided();
    fireEvent.keyDown(stage, { key: "Enter", shiftKey: true });
    expect(decided()).toMatch(/^5 of 10 decided/);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(decided()).toBe(before);
  });

  it("holds cuts behind the check until Cut anyway", async () => {
    const onWaive = vi.fn();
    const { stage } = setup({ initialItems: QUEUE_ITEMS, onWaive });
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(onWaive).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("lets a guest read without deciding", () => {
    const { stage, decided } = setup({ guest: true });
    const before = decided();
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(decided()).toBe(before);
  });

  it("ignores keys typed in a field", () => {
    const { stage, decided } = setup();
    const field = document.createElement("input");
    stage.append(field);
    const before = decided();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(decided()).toBe(before);
  });
});
