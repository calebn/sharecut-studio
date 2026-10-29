import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { reviewContent } from "../storybook/reviewContent";
import {
  EXTRA_KIND_ITEMS,
  QUEUE_CHECKED,
  QUEUE_ITEMS,
  QUEUE_WITHOUT_CHECKS,
} from "../storybook/reviewFixtures";
import {
  ReviewStageHarness,
  type ReviewStageHarnessProps,
} from "../storybook/reviewHarness";
import { ReviewStage } from "./ReviewStage";
import type { ReviewItem } from "./reviewQueueModel";

function setup(props: Partial<ReviewStageHarnessProps> = {}) {
  const view = render(
    <ReviewStageHarness
      initialItems={QUEUE_WITHOUT_CHECKS}
      content={reviewContent}
      duration={3000}
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
    const onDecide = vi.fn();
    const { press } = setup({ initialItems: QUEUE_ITEMS, onDecide });
    press("Enter");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]?.[0].waive).toBeDefined();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("closes the prompt after Cut anyway when the selection stays put", async () => {
    setup({ initialItems: QUEUE_ITEMS, initialSelectedId: "p1" });
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
  });

  it("closes the prompt when a refresh decides its items", () => {
    const props = {
      content: reviewContent,
      duration: 3000,
      filter: "all" as const,
      looksRight: new Set<string>(),
      selectedId: "f1",
      onSelect: vi.fn(),
      onFilter: vi.fn(),
      onLooksRight: vi.fn(),
      onDecide: vi.fn(),
    };
    const view = render(<ReviewStage {...props} items={QUEUE_ITEMS} />);
    const stage = view.container.querySelector(".rv-stage") as HTMLElement;
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
    const decided = QUEUE_ITEMS.map((i) =>
      i.id === "f1" ? { ...i, result: "applied" as const } : i,
    );
    view.rerender(<ReviewStage {...props} items={decided} />);
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
  });

  it("asks again when Undo brings the transcript check back", async () => {
    const onDecide = vi.fn();
    const { press } = setup({ initialItems: QUEUE_ITEMS, onDecide });
    press("Enter");
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    press("Enter");
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
    expect(onDecide).toHaveBeenCalledTimes(1);
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
    const { decided, press } = setup({
      initialItems: items,
      content: (item) => {
        const body = reviewContent(item);
        return { ...body, card: { ...body.card, why: undefined } };
      },
    });
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

  it("ignores a Cut all press and disables Find more while a bulk runs", async () => {
    const { decided } = setup({
      initialItems: [...QUEUE_WITHOUT_CHECKS, ...EXTRA_KIND_ITEMS],
      bulkRunning: { kind: "filler", total: 3, done: 1 },
      onFindMore: vi.fn(),
    });
    const before = decided();
    for (const b of screen.queryAllByRole("button", { name: /^Cut all/ }))
      await userEvent.click(b);
    expect(decided()).toBe(before);
    expect(screen.getByRole("button", { name: "Find more" })).toBeDisabled();
  });

  it("rolls back an unsure word's check when Undo reverts it", async () => {
    const { press } = setup({
      initialItems: QUEUE_CHECKED,
      initialSelectedId: "f3",
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

  it.each([
    ["r1", "repeat"],
    ["k1", "false start"],
    ["g1", "suggestion"],
  ])("holds a %s (%s) behind the open check until Cut anyway", async (id) => {
    const { press } = setup({
      initialItems: [...QUEUE_ITEMS, ...EXTRA_KIND_ITEMS],
      initialSelectedId: id,
    });
    press("Enter");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("gives repeats and false starts a group verb but other suggestions none", () => {
    setup({
      initialItems: EXTRA_KIND_ITEMS,
      initialSelectedId: "r1",
    });
    expect(
      screen.getAllByRole("button", { name: "Cut this one" }),
    ).toHaveLength(2);
    expect(screen.getByText("Other suggestions")).toBeInTheDocument();
  });

  it("lets an unplaced suggestion be decided by id", () => {
    const { decided, press } = setup({
      initialItems: EXTRA_KIND_ITEMS,
      initialSelectedId: "g2",
    });
    const before = decided();
    press("Enter");
    expect(decided()).not.toBe(before);
  });

  it("closes the phone queue sheet after a bulk", async () => {
    setup({ layout: "phone" });
    await userEvent.click(screen.getByRole("button", { name: /^\d+ of \d+$/ }));
    expect(screen.getAllByLabelText("Review queue")[0]).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Cut all/ }));
    expect(screen.queryAllByLabelText("Review queue")).toHaveLength(0);
    expect(screen.getByText(/^Cut \d · saves/)).toBeInTheDocument();
  });

  it("stops taking focus back once a pointer lands outside the stage", () => {
    const { stage, press } = setup();
    stage.focus();
    stage.blur();
    fireEvent.pointerDown(document.body);
    press("ArrowDown");
    expect(document.activeElement).toBe(document.body);
  });

  it("clears the prompt and the audition side when selection changes from outside", () => {
    const props = {
      items: QUEUE_ITEMS,
      content: reviewContent,
      duration: 3000,
      filter: "all" as const,
      looksRight: new Set<string>(),
      onSelect: vi.fn(),
      onFilter: vi.fn(),
      onLooksRight: vi.fn(),
      onDecide: vi.fn(),
    };
    const view = render(<ReviewStage {...props} selectedId="f1" />);
    const stage = view.container.querySelector(".rv-stage") as HTMLElement;
    fireEvent.keyDown(stage, { key: "Enter" });
    expect(props.onDecide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
    view.rerender(<ReviewStage {...props} selectedId="f2" />);
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
  });
});

describe("ReviewStage unsure words", () => {
  const fix = async (text: string) => {
    await userEvent.click(screen.getByRole("button", { name: "Fix text" }));
    const field = screen.getByRole("textbox", { name: /^Corrected text for/ });
    await userEvent.clear(field);
    if (text) await userEvent.type(field, text);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
  };

  it("sends the fixed text with the word's own decision, and gives a word no Keep", async () => {
    const onDecide = vi.fn();
    setup({ initialItems: QUEUE_ITEMS, initialSelectedId: "u1", onDecide });
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
    await fix("oncle");
    expect(onDecide).toHaveBeenCalledWith({
      ids: ["u1"],
      result: "applied",
      text: "oncle",
    });
  });

  it("gives a guest a word item no controls and no decision", () => {
    const onDecide = vi.fn();
    const { press } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "u1",
      guest: true,
      onDecide,
    });
    expect(
      screen.queryByRole("button", { name: /Fix text|Looks right/ }),
    ).toBeNull();
    press("Enter");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("says so and keeps the field when Save is empty", async () => {
    const onDecide = vi.fn();
    setup({ initialItems: QUEUE_ITEMS, initialSelectedId: "u1", onDecide });
    await fix("");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Type the corrected word.",
    );
    expect(
      screen.getByRole("textbox", { name: /^Corrected text for/ }),
    ).toHaveFocus();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("fixes a cut's word through its card, keeps the cut selected and leaves its verb to the host", async () => {
    const onDecide = vi.fn();
    const content = (item: ReviewItem) => {
      const body = reviewContent(item);
      return item.id === "f3" && body.card.unsure
        ? {
            ...body,
            card: { ...body.card, unsure: { ...body.card.unsure, id: "u1" } },
          }
        : body;
    };
    setup({
      initialItems: QUEUE_WITHOUT_CHECKS.concat({
        id: "u1",
        kind: "unsure-word",
        at: 614,
        savedSeconds: 0,
      }),
      initialSelectedId: "f3",
      content,
      onDecide,
    });
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
    await fix("oncle");
    expect(onDecide).toHaveBeenCalledWith({
      ids: ["u1"],
      result: "applied",
      text: "oncle",
    });
    expect(screen.getByRole("button", { name: "Cut" })).toBeDisabled();
  });
});

describe("ReviewStage host seams", () => {
  const withoutWave =
    (change?: { start: number; end: number }) => (item: ReviewItem) => {
      const body = reviewContent(item);
      return {
        ...body,
        card: { ...body.card, waveform: undefined, change },
      };
    };

  it("reports A and B from the buttons and the keys", async () => {
    const onHear = vi.fn();
    const { press } = setup({
      onHear,
      content: withoutWave({ start: 10, end: 11 }),
    });
    expect(screen.queryAllByRole("slider")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onHear).toHaveBeenLastCalledWith("f1", "A");
    await userEvent.click(screen.getByRole("button", { name: "B" }));
    expect(onHear).toHaveBeenLastCalledWith("f1", "B");
    press("a");
    expect(onHear).toHaveBeenLastCalledWith("f1", "A");
    press("b");
    expect(onHear).toHaveBeenLastCalledWith("f1", "B");
  });

  it("offers no A/B and reports no hear without a waveform or a change", () => {
    const onHear = vi.fn();
    const { press } = setup({ content: withoutWave(), onHear });
    expect(screen.queryByRole("button", { name: "A" })).toBeNull();
    press("a");
    press("b");
    expect(onHear).not.toHaveBeenCalled();
  });

  it("takes the primary verb from the item's suggested action", () => {
    const onDecide = vi.fn();
    const items: ReviewItem[] = [
      { id: "s1", kind: "sound", at: 5, savedSeconds: 0, suggested: "leave" },
      {
        id: "b1",
        kind: "sound",
        at: 6,
        savedSeconds: 0,
        suggested: "leave",
        blocked: true,
      },
      {
        id: "g1",
        kind: "suggestion",
        at: 9,
        savedSeconds: 1,
        suggested: "shorten",
      },
    ];
    const { press } = setup({
      initialItems: items,
      initialSelectedId: "s1",
      onDecide,
    });
    expect(screen.getAllByRole("button", { name: /^Keep/ })).toHaveLength(1);
    press("Enter");
    expect(onDecide).toHaveBeenLastCalledWith({ ids: ["s1"], result: "kept" });
    press("Enter");
    expect(onDecide).toHaveBeenCalledTimes(1);
    press("ArrowDown");
    expect(screen.getByRole("button", { name: /^Shorten/ })).toBeVisible();
  });

  const stageProps = (items: readonly ReviewItem[]) => ({
    items,
    content: reviewContent,
    duration: 3000,
    filter: "all" as const,
    looksRight: new Set<string>(),
    selectedId: "f1",
    onSelect: vi.fn(),
    onFilter: vi.fn(),
    onLooksRight: vi.fn(),
    onDecide: vi.fn(),
  });
  const press = (view: { container: HTMLElement }, key: string) =>
    fireEvent.keyDown(view.container.querySelector(".rv-stage") as Element, {
      key,
    });

  it("asks again when a transcript check comes back after Cut anyway", async () => {
    const view = render(<ReviewStage {...stageProps(QUEUE_ITEMS)} />);
    press(view, "Enter");
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    view.rerender(<ReviewStage {...stageProps(QUEUE_CHECKED)} />);
    press(view, "Enter");
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    view.rerender(<ReviewStage {...stageProps(QUEUE_ITEMS)} />);
    press(view, "Enter");
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
  });

  it("closes the prompt when a refresh closes the check", () => {
    const view = render(<ReviewStage {...stageProps(QUEUE_ITEMS)} />);
    press(view, "Enter");
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
    view.rerender(
      <ReviewStage {...stageProps(QUEUE_ITEMS.filter((i) => i.id !== "c1"))} />,
    );
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
    view.rerender(<ReviewStage {...stageProps(QUEUE_ITEMS)} />);
    expect(screen.queryByRole("button", { name: "Cut anyway" })).toBeNull();
  });

  it("shows the item's own reason on a blocked item", () => {
    const items: ReviewItem[] = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    setup({
      initialItems: items,
      content: (item) => {
        const body = reviewContent(item);
        return item.id === "f1"
          ? {
              ...body,
              card: { ...body.card, why: "Needs a closer look in Edit" },
            }
          : body;
      },
    });
    expect(screen.getByText("Needs a closer look in Edit")).toBeVisible();
    expect(
      screen.queryByText("The server will not apply this yet."),
    ).toBeNull();
  });

  it("opens no gate for a Lower and writes no waiver", () => {
    const onDecide = vi.fn();
    const items: ReviewItem[] = [
      { id: "c1", kind: "check", at: 0, savedSeconds: 0, transcript: true },
      { id: "s1", kind: "sound", at: 5, savedSeconds: 0, suggested: "lower" },
    ];
    const { press } = setup({
      initialItems: items,
      initialSelectedId: "s1",
      onDecide,
    });
    press("Enter");
    expect(screen.queryByRole("button", { name: "Lower anyway" })).toBeNull();
    expect(onDecide).toHaveBeenCalledWith({ ids: ["s1"], result: "applied" });
  });

  it("offers no Keep on the transcript check and keeps the gate for the next cut", async () => {
    const onDecide = vi.fn();
    const { press } = setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "c1",
      onDecide,
    });
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
    press("x");
    expect(onDecide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cut all 3" }));
    expect(screen.getByRole("button", { name: "Cut anyway" })).toBeVisible();
  });

  it.each([
    ["resolves false", async () => false],
    ["rejects", () => Promise.reject(new Error("down"))],
  ])("asks again after a Cut anyway whose decision %s", async (_, decide) => {
    const props = stageProps(QUEUE_ITEMS);
    props.onDecide = vi.fn(decide);
    const view = render(<ReviewStage {...props} />);
    press(view, "Enter");
    await userEvent.click(screen.getByRole("button", { name: "Cut anyway" }));
    press(view, "Enter");
    expect(
      await screen.findByRole("button", { name: "Cut anyway" }),
    ).toBeVisible();
  });

  it("disables the primary of a blocked item and says why in view", () => {
    const items = QUEUE_WITHOUT_CHECKS.map((i) =>
      i.id === "f1" ? { ...i, blocked: true } : i,
    );
    setup({ initialItems: items });
    const cut = screen.getByRole("button", { name: "Cut" });
    expect(cut).toBeDisabled();
    expect(screen.getByText("Open it in Edit to resolve.")).toBeVisible();
  });
});

describe("ReviewStage comments", () => {
  const comment = (over: Partial<ReviewStageHarnessProps> = {}) =>
    setup({
      initialItems: QUEUE_ITEMS,
      initialSelectedId: "m1",
      thread: () => <p>thread of m1</p>,
      ...over,
    });

  it("shows the thread in place of the quote", () => {
    comment();
    expect(screen.getByText("thread of m1")).toBeInTheDocument();
    expect(document.querySelector(".sys-decision-comment")).toBeNull();
  });

  it("resolves through its own handler, never as a Review decision", () => {
    const onResolve = vi.fn();
    const onDecide = vi.fn();
    const { press } = comment({ onResolve, onDecide });
    press("Enter");
    expect(onResolve).toHaveBeenCalledWith("m1");
    expect(onDecide).not.toHaveBeenCalled();
    press("x");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("offers no Keep and no second Resolve on a resolved comment", async () => {
    const onResolve = vi.fn();
    const items = QUEUE_ITEMS.map((i) =>
      i.id === "m1" ? { ...i, result: "applied" as const } : i,
    );
    const { press } = comment({ initialItems: items, onResolve });
    expect(screen.queryByRole("button", { name: /^Keep/ })).toBeNull();
    press("Enter");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("asks to focus the reply on R and leaves R alone in a field", () => {
    const onReply = vi.fn();
    const { press } = comment({
      onReply,
      thread: () => <textarea aria-label="Reply" />,
    });
    press("r");
    expect(onReply).toHaveBeenCalledWith("m1");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), {
      key: "r",
    });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("resolves a comment by swiping right on the phone card, and left does nothing", () => {
    const onResolve = vi.fn();
    const onDecide = vi.fn();
    comment({ layout: "phone", onResolve, onDecide });
    const body = document.querySelector(".sys-decision-body") as Element;
    const drag = (dx: number) => {
      fireEvent.pointerDown(body, {
        clientX: 200,
        clientY: 100,
        isPrimary: true,
        pointerId: 1,
      });
      fireEvent.pointerMove(body, {
        clientX: 200 + dx,
        clientY: 100,
        pointerId: 1,
      });
      fireEvent.pointerUp(body, {
        clientX: 200 + dx,
        clientY: 100,
        pointerId: 1,
      });
    };
    drag(-150);
    expect(onResolve).not.toHaveBeenCalled();
    drag(150);
    expect(onResolve).toHaveBeenCalledWith("m1");
    expect(onDecide).not.toHaveBeenCalled();
  });
});
