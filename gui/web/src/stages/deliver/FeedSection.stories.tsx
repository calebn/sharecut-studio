import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { FeedLive } from "./FeedLive";
import { FeedSection } from "./FeedSection";
import {
  AGENT_PIN,
  CHECKS,
  CHOOSE_SHOW,
  DRIFTED,
  FIRST_RUN,
  ITEM_XML,
  PENDING,
  READY,
  SHOW_TITLE,
  STALE,
  WRITE_FAILED,
  WRITING,
} from "./feedFixture";

const meta: Meta<typeof FeedSection> = {
  title: "Stages/Deliver/Podcast listing",
  component: FeedSection,
  tags: ["autodocs"],
  render: (args) => <FeedLive {...args} />,
  args: {
    view: READY,
    itemXml: ITEM_XML,
    onAction: fn(),
    onOpenSource: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "46rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    viewport: { options: studioViewports },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The episode as a podcast app will show it, with the feed file behind it. No inputs show until you click a value. Auto sits on a value a click would pin, Edited on one you wrote, and Agent on one an agent wrote. A missing value says what it needs, and the strip above leads with the one button that supplies the first. Checks keeps the rest closed, and the footer writes the feed file. Every edit and command leaves through `onAction` in the vocabulary the CLI and MCP share.\n\n**Story only.** The GUI is the only surface that speaks this view today.\n\n**Not mounted yet.** Deliver does not render this section until the listing API lands.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof FeedSection>;

export const Preview: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Ready to publish")).toBeInTheDocument();
    await expect(
      view.getByRole("heading", { name: /^Nobody asked the river/ }),
    ).toBeInTheDocument();
    await expect(view.getByText("52 min")).toBeInTheDocument();
    await expect(view.getByText("From your show")).toBeInTheDocument();
    await expect(
      view.getByText("Assigned Oct 23, 2026. It never changes."),
    ).toBeInTheDocument();
    await expect(
      view.getByRole("button", {
        name: "Transcript SRT · VTT. Open transcript",
      }),
    ).toBeInTheDocument();
  },
};

export const EditingInPlace: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(
      view.getByRole("button", { name: "Nobody asked the river" }),
    );
    const field = view.getByRole("textbox", { name: "Edit episode title" });
    await expect(field).toHaveFocus();
    await userEvent.type(field, " (extended)");
    await expect(
      view.getByRole("button", { name: "Done" }),
    ).toBeInTheDocument();
  },
};

export const DriftedPin: Story = {
  args: { view: DRIFTED },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("Check the notes")).toBeInTheDocument();
    await expect(
      view.getByText(/This changed since you edited it\./),
    ).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Keep mine" }),
    ).toBeInTheDocument();
  },
};

export const UseNewThenUndo: Story = {
  args: { view: DRIFTED },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Use new" }));
    await expect(args.onAction).toHaveBeenCalledWith({
      kind: "edit",
      edit: { op: "unset", key: "item.notes" },
    });
    await expect(
      view.getByText("Your notes are back to auto."),
    ).toBeInTheDocument();
    await userEvent.click(view.getByRole("button", { name: "Undo" }));
    await expect(view.getByText(/0:00 Cold open/)).toBeInTheDocument();
  },
};

export const Pending: Story = {
  args: { view: PENDING },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("2 things left")).toBeInTheDocument();
    await expect(
      view.getAllByRole("button", { name: "Add address" }),
    ).toHaveLength(1);
  },
};

export const ShowSetupEmpty: Story = {
  args: { view: FIRST_RUN },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("heading", { name: "Set up your show" }),
    ).toBeInTheDocument();
    await expect(view.getByRole("button", { name: "Create" })).toBeDisabled();
    const name = view.getByLabelText("Show name");
    await userEvent.type(name, SHOW_TITLE);
    await expect(view.getByRole("button", { name: "Create" })).toBeEnabled();
    await userEvent.clear(name);
    await userEvent.tab({ shift: true });
  },
};

export const ShowPick: Story = {
  args: { view: CHOOSE_SHOW },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Field Notes" }));
    await expect(args.onAction).toHaveBeenCalledWith({
      kind: "command",
      command: "link_show",
      args: { id: "field-notes" },
    });
    await expect(view.getByText("Field Notes")).toBeInTheDocument();
  },
};

export const Checks: Story = {
  args: { view: CHECKS },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("2 things left")).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Copy feed item" }),
    ).toBeDisabled();
    await expect(view.getAllByText("Fix the blocker first.")).not.toHaveLength(
      0,
    );
    await userEvent.click(view.getByText("Checks"));
    await expect(view.getAllByText("Apple")).toHaveLength(2);
    await expect(view.getByText("Spotify")).toBeInTheDocument();
  },
};

export const StaleFile: Story = {
  args: { view: STALE },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Feed file is out of date."),
    ).toBeInTheDocument();
    await expect(view.getByRole("button", { name: "Write" })).toBeEnabled();
  },
};

export const Writing: Story = {
  args: { view: WRITING },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Writing the feed file."),
    ).toBeInTheDocument();
  },
};

export const WriteFailed: Story = {
  args: { view: WRITE_FAILED },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Could not write the feed file."),
    ).toBeInTheDocument();
    await expect(view.getByRole("button", { name: "Try again" })).toBeEnabled();
  },
};

export const XmlView: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "XML" }));
    await expect(
      view.getByRole("button", { name: "XML", pressed: true }),
    ).toBeInTheDocument();
    await expect(view.getByLabelText("Item XML")).toHaveTextContent(
      "<itunes:duration>3120</itunes:duration>",
    );
  },
};

export const AgentPin: Story = {
  args: { view: AGENT_PIN },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Agent")).toBeInTheDocument();
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const Phone: Story = {
  args: { view: PENDING },
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
