import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_ITEMS, QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { ReviewStage, type ReviewStageProps } from "./ReviewStage";
import type { ReviewItem } from "./reviewQueue";

const CLOCK = { time: "12:04", total: "52:10" };

function setup(props: Partial<ReviewStageProps> = {}) {
  const view = render(
    <ReviewStage
      initialItems={QUEUE_WITHOUT_CHECKS}
      content={reviewContent}
      duration={3000}
      clock={CLOCK}
      initialSelectedId="f1"
      {...props}
    />,
  );
  const stage = view.container.querySelector(".rv-stage") as HTMLElement;
  const decided = () => screen.getByText(/of \d+ decided/).textContent;
  const press = (key: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(stage, { key, ...init });
  return { stage, decided, press, ...view };
}

describe("ReviewStage", () => {
  it("decides with Enter and advances in the same frame", () => {
    const { decided, press } = setup();
    const before = decided();
    press("Enter");
    expect(decided()).not.toBe(before);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("applies the group with Shift+Enter as one undo step, skipping unsure cuts", async () => {
    const { decided, press } = setup();
    const before = decided();
    press("Enter", { shiftKey: true });
    expect(decided()).toMatch(/^5 of 10 decided/);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(decided()).toBe(before);
  });

  it("does not decide again while a key is held", () => {
    const { decided, press } = setup();
    press("Enter");
    const once = decided();
    press("Enter", { repeat: true });
    press("x", { repeat: true });
    expect(decided()).toBe(once);
  });

  it("leaves Tab alone on the root and on the toast Undo button", () => {
    const { stage, press } = setup();
    press("x");
    const root = fireEvent.keyDown(stage, { key: "Tab" });
    const undo = fireEvent.keyDown(
      screen.getByRole("button", { name: "Undo" }),
      { key: "Tab" },
    );
    expect(root).toBe(true);
    expect(undo).toBe(true);
  });

  it("does not re-decide a decided item", () => {
    const { decided, press } = setup({ initialSelectedId: "p0" });
    const before = decided();
    press("Enter");
    expect(decided()).toBe(before);
  });

  it("keeps the only undecided item selected on ArrowDown", () => {
    const items = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? i : { ...i, result: "kept" as const },
    );
    const { press } = setup({ initialItems: items });
    press("ArrowDown");
    expect(screen.getByText("Remove “um, you know,”")).toBeInTheDocument();
  });

  it("steps only through the filtered queue", () => {
    const { press } = setup({
      initialItems: QUEUE_ITEMS,
      initialFilter: "comments",
      initialSelectedId: "m1",
    });
    press("ArrowDown");
    expect(screen.getByText("Rosa asks about the laugh")).toBeInTheDocument();
  });

  it("holds cuts behind the check until Cut anyway", async () => {
    const onWaive = vi.fn();
    const { press } = setup({ initialItems: QUEUE_ITEMS, onWaive });
    press("Enter");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(onWaive).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("asks for Cut anyway on an unsure cut while the check is open", () => {
    const { press } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "f3",
    });
    press("Enter");
    expect(
      screen.getByRole("button", { name: "Cut anyway" }),
    ).toBeInTheDocument();
  });

  it("does not cut a blocked suggestion and says why", () => {
    const items: ReviewItem[] = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    const { decided, press } = setup({ initialItems: items });
    const before = decided();
    press("Enter");
    expect(decided()).toBe(before);
    expect(
      screen.getByText("The server will not apply this yet."),
    ).toBeInTheDocument();
  });

  it("resolves only the transcript check, not other checks", async () => {
    const items: ReviewItem[] = [
      ...QUEUE_ITEMS,
      { id: "c2", kind: "check", at: 1, savedSeconds: 0 },
    ];
    const { press } = setup({ initialItems: items });
    press("Enter");
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(screen.getByText(/^4 of 13 decided/)).toBeInTheDocument();
  });

  it("lets a guest read without deciding", () => {
    const { decided, press } = setup({ guest: true });
    const before = decided();
    press("Enter");
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
