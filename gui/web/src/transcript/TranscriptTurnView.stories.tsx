import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import {
  TranscriptTurnView,
  type TranscriptTurnViewProps,
} from "./TranscriptTurnView";

const base: TranscriptTurnViewProps = {
  speaker: "Mira",
  labelSec: 12.4,
  seekSec: 12.4,
  turnIndex: 0,
  segments: [
    {
      key: "mira-12",
      words: [
        {
          word: { text: "We", start: 12.4, end: 12.7, word_index: 1 },
          trackId: "mira",
          interactive: true,
        },
        {
          word: { text: "found", start: 12.7, end: 13.2, word_index: 2 },
          trackId: "mira",
          interactive: true,
        },
        {
          word: { text: "the", start: 13.2, end: 13.4, word_index: 3 },
          trackId: "mira",
          interactive: true,
        },
        {
          word: { text: "signal.", start: 13.4, end: 14.1, word_index: 4 },
          trackId: "mira",
          interactive: true,
        },
      ],
    },
  ],
};

const meta: Meta<typeof TranscriptTurnView> = {
  title: "Templates/TranscriptTurn",
  component: TranscriptTurnView,
  tags: ["autodocs"],
  args: base,
  decorators: [
    (Story) => (
      <main className="transcript-panel" aria-label="Transcript turn preview">
        <div className="transcript-list">
          <Story />
        </div>
      </main>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof TranscriptTurnView>;

function InteractiveTurn(args: TranscriptTurnViewProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [seek, setSeek] = useState<string>("");
  return (
    <>
      <TranscriptTurnView
        {...args}
        onSeek={() => setSeek("Turn selected at 12.4s")}
        segments={args.segments.map((segment) => ({
          ...segment,
          words: segment.words.map((item) => ({
            ...item,
            selected: item.word.word_index === selected,
            buttonProps: {
              onClick: () => setSelected(item.word.word_index ?? null),
            },
          })),
        }))}
      />
      <output>{seek}</output>
    </>
  );
}

export const Mapped: Story = {
  render: (args) => <InteractiveTurn {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "found" }));
    await expect(canvas.getByRole("button", { name: "found" })).toHaveClass(
      "selected",
    );
    await userEvent.click(canvas.getByRole("button", { name: /Mira/ }));
    await expect(
      canvas.getByText("Turn selected at 12.4s"),
    ).toBeInTheDocument();
  },
};

export const ActiveSelected: Story = {
  args: {
    active: true,
    segments: base.segments.map((segment) => ({
      ...segment,
      active: true,
      words: segment.words.map((item) => ({
        ...item,
        active: item.word.word_index === 2,
        selected: item.word.word_index === 2,
      })),
    })),
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(
        ".utterance-turn.active .utterance-word.active.selected",
      ),
    ).toBeInTheDocument();
  },
};

export const SuppressedLowConfidence: Story = {
  args: {
    segments: [
      {
        key: "mira-12",
        words: [
          {
            word: {
              text: "Maybe",
              start: 12.4,
              end: 12.8,
              confidence: 0.41,
              word_index: 1,
            },
            trackId: "mira",
            interactive: true,
            lowConfidence: true,
          },
          {
            word: {
              text: "actually",
              start: 12.8,
              end: 13.2,
              suppressed: true,
              word_index: 2,
            },
            trackId: "mira",
            interactive: true,
          },
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".utterance-word.low-confidence"),
    ).toHaveTextContent("Maybe");
    await expect(
      canvasElement.querySelector(".utterance-word.suppressed"),
    ).toHaveTextContent("actually");
  },
};

export const UnmappedCutAway: Story = {
  args: {
    seekSec: null,
    unmapped: true,
    segments: [
      {
        key: "mira-cutaway",
        unmapped: true,
        words: [
          {
            word: {
              text: "discarded",
              start: 12.4,
              end: 13.0,
              mappable: false,
              word_index: 1,
            },
            trackId: "mira",
            unmapped: true,
            interactive: false,
            title: "Cut-away word",
          },
          {
            word: {
              text: "phrase",
              start: 13.0,
              end: 13.5,
              mappable: false,
              word_index: 2,
            },
            trackId: "mira",
            unmapped: true,
            interactive: false,
            title: "Cut-away word",
          },
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".utterance-turn.unmapped"),
    ).toBeInTheDocument();
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
  },
};

export const MobileLongTurn: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    segments: [
      {
        key: "mira-long",
        words:
          "We kept this longer answer together so the transcript wraps naturally on a narrow phone while every word stays readable and selectable"
            .split(" ")
            .map((text, index) => ({
              word: {
                text,
                start: 12.4 + index * 0.3,
                end: 12.7 + index * 0.3,
                word_index: index,
              },
              trackId: "mira",
              interactive: true,
            })),
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(".utterance-word"),
    ).toHaveLength(22);
  },
};
