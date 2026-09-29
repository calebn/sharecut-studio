import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  TranscriptTurnView,
  type TranscriptTurnViewProps,
} from "./TranscriptTurnView";

const props: TranscriptTurnViewProps = {
  speaker: "Mira",
  labelSec: 12.4,
  seekSec: 12.4,
  turnIndex: 7,
  segments: [
    {
      key: "mira-7",
      words: [
        {
          word: { text: "hello", start: 12.4, end: 12.8, word_index: 4 },
          trackId: "mira",
          interactive: true,
          selected: true,
          active: true,
        },
        {
          word: {
            text: "again",
            start: 12.8,
            end: 13.2,
            word_index: 5,
            suppressed: true,
          },
          trackId: "mira",
          interactive: false,
          lowConfidence: true,
        },
      ],
    },
  ],
};

describe("TranscriptTurnView", () => {
  it("renders production row classes and semantic controls", async () => {
    const onSeek = vi.fn();
    const onClick = vi.fn();
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          active
          onSeek={onSeek}
          segments={[
            {
              ...props.segments[0],
              words: [
                { ...props.segments[0].words[0], buttonProps: { onClick } },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    expect(container.querySelector(".utterance-turn.active")).toHaveAttribute(
      "data-turn-index",
      "7",
    );
    expect(
      within(container).getByRole("button", { name: "hello" }),
    ).toHaveClass("active", "selected");
    expect(
      container.querySelector(".utterance-word.suppressed.low-confidence"),
    ).toHaveTextContent("again");
    fireEvent.click(within(container).getByRole("button", { name: /Mira/ }));
    fireEvent.click(within(container).getByRole("button", { name: "hello" }));
    expect(onSeek).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("shows unmapped turns without seek or word controls", async () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          seekSec={null}
          unmapped
          segments={[
            {
              key: "cutaway",
              unmapped: true,
              words: [
                {
                  word: { text: "cutaway", start: 0, end: 1, mappable: false },
                  trackId: "mira",
                  unmapped: true,
                },
              ],
            },
          ]}
        />
      </main>,
    );
    expect(
      container.querySelector(
        ".utterance-turn.unmapped .utterance-word.unmapped",
      ),
    ).toHaveTextContent("cutaway");
    expect(within(container).queryByRole("button")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("dims a suppressed-only turn and notes it (#758)", async () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          suppressedOnly
          segments={[
            {
              key: "guest-758",
              suppressedOnly: true,
              words: [
                {
                  word: {
                    text: "um",
                    start: 0,
                    end: 0.2,
                    word_index: 0,
                    suppressed: true,
                  },
                  trackId: "guest",
                },
              ],
            },
          ]}
        />
      </main>,
    );
    expect(
      container.querySelector(".utterance-turn.suppressed-only"),
    ).not.toBeNull();
    expect(
      container.querySelector(".utterance-seg.suppressed-only"),
    ).toHaveTextContent("um");
    expect(container.querySelector(".utterance-note")).toHaveTextContent(
      "all suppressed",
    );
    await expectNoA11yViolations(container);
  });

  it("renders a word's editor slot instead of its chip", () => {
    const { container, queryByRole, getByLabelText } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                {
                  ...props.segments[0].words[0],
                  editor: <input aria-label="edit hello" />,
                },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    expect(getByLabelText("edit hello")).toBeInTheDocument();
    expect(queryByRole("button", { name: "hello" })).toBeNull();
    expect(container).toBeTruthy();
  });

  it("marks an ignored word chip and renders its restore control (#633)", () => {
    const { container, getByRole } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                {
                  ...props.segments[0].words[0],
                  word: { ...props.segments[0].words[0].word, ignored: true },
                  restoreControl: (
                    <button type="button" aria-label="Restore ignored: hello">
                      Restore
                    </button>
                  ),
                },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    const chip = container.querySelector(".utterance-word.ignored");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("hello");
    const restore = getByRole("button", { name: "Restore ignored: hello" });
    expect(restore).toBeInTheDocument();
    // The run's last word wrapper anchors the overlaid control (#672 review).
    expect(restore.parentElement).toHaveClass("utterance-restore-anchor");
    expect(
      container.querySelectorAll(".utterance-restore-anchor"),
    ).toHaveLength(1);
  });

  it("marks an audibility-locked word chip (#781)", async () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                {
                  ...props.segments[0].words[0],
                  word: {
                    ...props.segments[0].words[0].word,
                    audibility_locked: true,
                  },
                  title:
                    "Suppression locked: set directly, not by a heuristic pass.",
                },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    const chip = container.querySelector(".utterance-word.locked");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("hello");
    await expectNoA11yViolations(container);
  });

  it("marks the current low-confidence walkthrough stop (#634)", () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                { ...props.segments[0].words[0], reviewCurrent: true },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    const current = container.querySelector(".utterance-word.review-current");
    expect(current).not.toBeNull();
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current?.tagName).toBe("BUTTON");
    const others = container.querySelectorAll(
      ".utterance-word:not(.review-current)",
    );
    for (const el of others) {
      expect(el).not.toHaveAttribute("aria-current");
    }
  });

  it("marks a non-interactive current stop too", () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                props.segments[0].words[0],
                { ...props.segments[0].words[1], reviewCurrent: true },
              ],
            },
          ]}
        />
      </main>,
    );
    const current = container.querySelector(".utterance-word.review-current");
    expect(current).not.toBeNull();
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current?.tagName).toBe("SPAN");
  });

  it("marks an interactive prominent word and announces it (#719)", () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                { ...props.segments[0].words[0], prominent: true },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    const word = container.querySelector(".utterance-word.prominent");
    expect(word).not.toBeNull();
    expect(word?.tagName).toBe("BUTTON");
    expect(word?.textContent).toContain("emphasized");
  });

  it("marks a non-interactive prominent word and announces it (#719)", () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                props.segments[0].words[0],
                { ...props.segments[0].words[1], prominent: true },
              ],
            },
          ]}
        />
      </main>,
    );
    const word = container.querySelector(".utterance-word.prominent");
    expect(word).not.toBeNull();
    expect(word?.tagName).toBe("SPAN");
    expect(word?.textContent).toContain("emphasized");
  });

  it("folds prominent into the suspect aria-label join", () => {
    const { container } = render(
      <main>
        <TranscriptTurnView
          {...props}
          segments={[
            {
              ...props.segments[0],
              words: [
                {
                  ...props.segments[0].words[0],
                  prominent: true,
                  suspectHallucination: true,
                  ariaLabel: "hello",
                },
                props.segments[0].words[1],
              ],
            },
          ]}
        />
      </main>,
    );
    const word = container.querySelector(".utterance-word.prominent");
    expect(word?.getAttribute("aria-label")).toContain("emphasized");
  });
});
