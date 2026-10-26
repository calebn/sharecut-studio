import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { CLEAR_FACTS, MEASURED_FACTS, OPEN_FACTS } from "./deliverFixture";
import { readinessRows } from "./deliverLogic";
import { Readiness } from "./Readiness";

const meta: Meta<typeof Readiness> = {
  title: "Stages/Deliver/Readiness",
  component: Readiness,
  tags: ["autodocs"],
  args: { rows: readinessRows(CLEAR_FACTS), onFix: fn(), onRetry: fn() },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "65rem" }}>
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
          "A Status list under a sentence that says how much is left. Two columns on desktop, one on phone. An open row has one fix that opens its stage with the item selected. Nothing here blocks Export.\n\n**Motion.** Animations come later: a row that clears fades its warning glyph into the check with `--motion-hover`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Readiness>;

export const AllClear: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Ready to export"),
    ).toBeInTheDocument();
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
  },
};

export const ItemsOpen: Story = {
  args: { rows: readinessRows(OPEN_FACTS) },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Check" }));
    await expect(args.onFix).toHaveBeenCalledWith("review", "unsure-words");
  },
};

export const AfterExport: Story = {
  args: { rows: readinessRows(MEASURED_FACTS) },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("−16.1 LUFS"),
    ).toBeInTheDocument();
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const LoadError: Story = { name: "Error", args: { state: "error" } };

export const Phone: Story = {
  args: { rows: readinessRows(OPEN_FACTS) },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
