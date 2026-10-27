import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reviewContent } from "../storybook/reviewContent";
import { QUEUE_ITEMS, QUEUE_WITHOUT_CHECKS } from "../storybook/reviewFixtures";
import { ReviewStage, type ReviewStageProps } from "./ReviewStage";
import type { ReviewItem } from "./reviewQueueModel";

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

  it("words the prompt for the group's verb, not the selection's, when its header is clicked", async () => {
    setup({ initialItems: QUEUE_ITEMS, initialSelectedId: "p1" });
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    expect(
      screen.getByRole("button", { name: "Cut anyway" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(screen.getByText(/^Cut 3 · saves/)).toBeInTheDocument();
  });

  it("never cuts an unresolved unsure item, even through Cut anyway", () => {
    const { decided, press } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "f3",
    });
    const before = decided();
    press("Enter");
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    expect(decided()).toBe(before);
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

  it("shows a non-guest the unsure-word controls", () => {
    setup({ initialItems: QUEUE_ITEMS, initialSelectedId: "f3" });
    expect(
      screen.getByRole("button", { name: /Fix text/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Looks right/ }),
    ).toBeInTheDocument();
  });

  it("gives a guest no unsure-word controls and no decision", () => {
    const { decided } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "f3",
      guest: true,
    });
    const before = decided();
    expect(screen.queryByRole("button", { name: /Fix text/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Looks right/ })).toBeNull();
    expect(decided()).toBe(before);
  });

  it("opens Edit and comments on the selected item", () => {
    const onOpenInEdit = vi.fn();
    const onComment = vi.fn();
    const { press } = setup({ onOpenInEdit, onComment });
    press("e");
    press("c");
    expect(onOpenInEdit).toHaveBeenCalledWith("f1");
    expect(onComment).toHaveBeenCalledWith("f1");
  });

  it("gives a guest no Open in Edit key", () => {
    const onOpenInEdit = vi.fn();
    const { press } = setup({ guest: true, onOpenInEdit });
    press("e");
    expect(onOpenInEdit).not.toHaveBeenCalled();
  });

  it("returns focus to the stage when the focused button unmounts", async () => {
    const { stage, decided } = setup();
    const keep = screen.getByRole("button", { name: /^Keep/ });
    keep.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(stage);
    const before = decided();
    await userEvent.keyboard("x");
    expect(decided()).not.toBe(before);
  });

  it("derives saved seconds from the range, not from a stale render", () => {
    const saves = () => screen.getByText(/^Saves /).textContent;
    const nudge = (times: number) =>
      act(() => {
        const handle = screen.getAllByRole("slider")[1] as HTMLElement;
        for (let i = 0; i < times; i++) {
          fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
        }
      });
    const first = setup();
    const original = saves();
    nudge(1);
    const once = saves();
    first.unmount();
    setup();
    nudge(3);
    expect(saves()).toBe(once);
    expect(once).not.toBe(original);
    act(() => {
      fireEvent.keyDown(screen.getAllByRole("slider")[1] as HTMLElement, {
        key: "ArrowLeft",
        shiftKey: true,
      });
    });
    expect(saves()).toBe(original);
  });

  it("returns focus to the stage after Undo removes the toast", async () => {
    const { stage, press } = setup();
    stage.focus();
    press("x");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(document.activeElement).toBe(stage);
  });

  it("returns focus to the stage after the prompt's Check button", async () => {
    const { stage, press } = setup({ initialItems: QUEUE_ITEMS });
    stage.focus();
    press("Enter");
    await userEvent.click(
      screen.getByRole("button", { name: /^Check 1 word/ }),
    );
    expect(document.activeElement).toBe(stage);
  });

  it("does not take focus before anything in the stage was used", () => {
    setup();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not start a second bulk while one runs", () => {
    const { decided, press } = setup({
      bulkRunning: { kind: "filler", total: 3, done: 1 },
    });
    const before = decided();
    press("Enter", { shiftKey: true });
    expect(decided()).toBe(before);
  });

  it("rolls back an unsure word's check when Undo reverts it", async () => {
    const { press } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "f3",
      gateConfirmed: true,
    });
    await userEvent.click(screen.getByRole("button", { name: "Looks right" }));
    press("Enter");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByRole("button", { name: "Looks right" }),
    ).toBeInTheDocument();
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
