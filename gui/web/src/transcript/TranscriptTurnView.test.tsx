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
});
