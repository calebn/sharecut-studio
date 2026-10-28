import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { ROWS } from "./prepareFixture";
import { ReadyList } from "./ReadyList";

const meta: Meta<typeof ReadyList> = {
  title: "Stages/Prepare/ReadyList",
  component: ReadyList,
  tags: ["autodocs"],
  args: { rows: ROWS.running, onAction: fn() },
  decorators: [
    (Story) => (
      <main
        aria-label="Stage"
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "40rem",
          background: "var(--color-bg-canvas)",
        }}
      >
        <Story />
      </main>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The Getting ready rows: Add audio, Transcribe, Line up tracks, Clean and level, Find suggestions, each a Status row in a Status list. A row has one primary action in its line; any other button sits in the row\'s opened body as a labelled group (Hear it, Looks right, Undo move; Keep my fixes, Replace). A row that needs you comes first and starts open, but opening never moves focus, so a step that finishes while someone types does not pull them away. Keep my fixes is the filled default and Replace, which overwrites hand-fixed words, is the outlined danger button. Rows are 48 px at every width. The words say what to do: "Download 1.6 GB", "Download word timing (360 MB)".\n\n**Motion.** Bars grow with `--motion-state`; a row opens with `--motion-panel`. Not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ReadyList>;

export const Queued: Story = {
  args: { rows: ROWS.queued },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole("list", {
      name: "Getting ready",
    });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    await expect(within(list).getAllByText("Not yet")).toHaveLength(4);
  },
};

export const Running: Story = {
  args: { rows: ROWS.running },
  play: async ({ canvasElement }) => {
    const bar = within(canvasElement).getByRole("progressbar", {
      name: "Transcribe",
    });
    await expect(bar).toHaveAttribute("aria-valuenow", "60");
    await expect(bar).toHaveAttribute(
      "aria-valuetext",
      "2 of 3 speakers · about 1 min left",
    );
  },
};

export const NeedsAlignCheck: Story = {
  args: { rows: ROWS.alignCheck },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const items = canvas.getAllByRole("listitem");
    await expect(within(items[2]).getByText("Line up tracks")).toBeVisible();
    const group = canvas.getByRole("group", { name: /Listen to the move/ });
    await userEvent.click(
      within(group).getByRole("button", { name: "Looks right" }),
    );
    await expect(args.onAction).toHaveBeenCalledWith("align", "looks-right");
  },
};

export const NeedsModel: Story = {
  args: { rows: ROWS.needsModel },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")[1]).toHaveTextContent(
      "Transcribe",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: /^Download 1.6 GB/ }),
    );
    await expect(args.onAction).toHaveBeenCalledWith(
      "transcribe",
      "download-model",
    );
  },
};

export const KeepMyFixes: Story = {
  args: { rows: ROWS.keepFixes },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Keep my fixes" }),
    ).toHaveFocus();
    await expect(canvas.getByRole("button", { name: "Replace" })).toBeVisible();
    const row = canvas.getByRole("button", { name: /Transcribe/ });
    await userEvent.click(row);
    await userEvent.click(row);
    await expect(
      canvas.getByRole("button", { name: "Keep my fixes" }),
    ).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onAction).toHaveBeenCalledWith(
      "transcribe",
      "keep-fixes",
    );
  },
};

export const Failed: Story = {
  args: { rows: ROWS.failed },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Try again/ }));
    await expect(args.onAction).toHaveBeenCalledWith("transcribe", "try-again");
    await expect(canvas.getByText("Not enough memory to finish")).toBeVisible();
    const details = canvas.getByRole("button", {
      name: "Details for Transcribe",
    });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(details);
    await expect(canvas.getByText(/ran out of memory/)).toBeVisible();
  },
};

export const Done: Story = {
  args: { rows: ROWS.done },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText("Done")).toHaveLength(5);
  },
};

export const ApproximateTiming: Story = {
  args: { rows: ROWS.approximateTiming },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: /^Download word timing \(360 MB\)/ }),
    );
    await expect(args.onAction).toHaveBeenCalledWith(
      "transcribe",
      "download-aligner",
    );
  },
};
