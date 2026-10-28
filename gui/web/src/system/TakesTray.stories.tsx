import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { TakesTray } from "./TakesTray";
import type { TakeInput, TakePersonInput } from "./takesTrayModel";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const JON = { name: "Jon", colorIndex: 3 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const LONG = {
  name: "Bartholomew Featherstonehaugh-Wellington",
  colorIndex: 4,
};

const saved = (person: TakePersonInput["person"]): TakePersonInput => ({
  person,
  line: { kind: "saved" },
});

const SAVED_TAKE: TakeInput = {
  id: "t1",
  number: 1,
  lengthSec: 872,
  people: [saved(MAYA), saved(JON), saved(ANNEKE)],
};

const meta: Meta<typeof TakesTray> = {
  title: "Stages/Record/TakesTray",
  component: TakesTray,
  tags: ["autodocs"],
  args: {
    takes: [SAVED_TAKE],
    onHear: fn(),
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "36rem", inlineSize: "min(100%, 20rem)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The Takes segment of the Record rail: one Status row per take with its length and people, expandable to a line per person with the saving percent, the clips with their times, and Retry when a take could not be added to the timeline. Hear plays a take once everyone's audio has landed. Many takes scroll inside the tray. Presentational: the caller owns the takes and the handlers.\n\n**Motion.** Rows expand with `--motion-panel` and the saving bar grows with `--motion-state`, both from Status row. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TakesTray>;

export const Empty: Story = {
  args: { takes: [] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(/No takes yet/),
    ).toBeInTheDocument();
  },
};

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Take 1")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Hear Take 1" }),
    ).toBeInTheDocument();
  },
};

export const LiveTake: Story = {
  args: {
    takes: [
      SAVED_TAKE,
      {
        id: "t2",
        number: 2,
        lengthSec: 191,
        live: true,
        people: [saved(MAYA), saved(JON), saved(ANNEKE)],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Recording · 3:11 · 3 people"),
    ).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: /^Hear/ })).toHaveLength(
      1,
    );
  },
};

export const Saving: Story = {
  args: {
    defaultExpanded: ["t1"],
    takes: [
      {
        id: "t1",
        number: 1,
        lengthSec: 872,
        people: [
          saved(MAYA),
          { person: JON, line: { kind: "saving", done: 4, total: 10 } },
          { person: ANNEKE, line: { kind: "saving", done: 9, total: 10 } },
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Saving 40%")).toBeInTheDocument();
    await expect(canvas.getByText("Saving 90%")).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: /^Hear/ }),
    ).not.toBeInTheDocument();
  },
};

export const MultipleSegments: Story = {
  args: {
    defaultExpanded: ["t2"],
    takes: [
      SAVED_TAKE,
      {
        id: "t2",
        number: 2,
        lengthSec: 341,
        people: [
          saved(MAYA),
          { person: JON, line: { kind: "offline" } },
          { person: ANNEKE, line: { kind: "saving", done: 2, total: 5 } },
        ],
      },
      {
        id: "t3",
        number: 3,
        lengthSec: 95,
        people: [saved(MAYA), saved(JON), saved(ANNEKE)],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Waiting for Jon to come back online"),
    ).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: /^Hear/ })).toHaveLength(
      2,
    );
  },
};

export const LandFailed: Story = {
  args: {
    defaultExpanded: ["t2"],
    takes: [
      SAVED_TAKE,
      {
        id: "t2",
        number: 2,
        lengthSec: 341,
        people: [
          saved(MAYA),
          { person: JON, line: { kind: "land-failed" } },
          saved(ANNEKE),
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Couldn't add to the timeline"),
    ).toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Retry Jon, Take 2" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Retry Jon, Take 2" }),
    ).toBeInTheDocument();
  },
};

export const WithClipping: Story = {
  args: {
    defaultExpanded: ["t1"],
    takes: [
      {
        id: "t1",
        number: 1,
        lengthSec: 872,
        people: [
          saved(MAYA),
          { ...saved(JON), clipTimes: ["02:14", "05:40", "09:02"] },
          saved(ANNEKE),
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Saved · Clipped 3 times · 02:14, 05:40, 09:02",
      ),
    ).toBeInTheDocument();
  },
};

export const TwelveTakes: Story = {
  args: {
    takes: Array.from({ length: 12 }, (_, index) => ({
      id: `t${index + 1}`,
      number: index + 1,
      lengthSec: 120 + index * 47,
      people: [saved(MAYA), saved(JON), saved(ANNEKE)],
    })),
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getAllByRole("button", { name: /^Hear/ }),
    ).toHaveLength(12);
  },
};

export const LongNamesPhone: Story = {
  args: {
    defaultExpanded: ["t1"],
    takes: [
      {
        id: "t1",
        number: 1,
        lengthSec: 3725,
        people: [
          saved(MAYA),
          { person: LONG, line: { kind: "offline" } },
          { person: ANNEKE, line: { kind: "land-failed" } },
        ],
      },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ blockSize: "36rem", inlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Waiting for Bartholomew Featherstonehaugh-Wellington to come back online",
      ),
    ).toBeInTheDocument();
    await expect(
      within(canvasElement).getByText("1:02:05 · 3 people"),
    ).toBeInTheDocument();
  },
};
