import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  studioViewports,
  viewportStoryParameters,
} from "../../storybook/storyLayout";
import { FeedSection } from "./FeedSection";
import {
  AGENT_PIN,
  applyEdit,
  CHECKS,
  DRIFTED,
  FIRST_RUN,
  ITEM_XML,
  PENDING,
  READY,
  SHOW_TITLE,
  STALE,
} from "./feedFixture";
import type { FeedView } from "./feedView";

type Args = React.ComponentProps<typeof FeedSection>;

function Live({ view: first, ...rest }: Args) {
  const [view, setView] = useState<FeedView>(first);
  return (
    <FeedSection
      {...rest}
      view={view}
      onEdit={(edit) => {
        rest.onEdit(edit);
        setView((now) => applyEdit(now, edit));
      }}
      onCreateShow={(title) => {
        rest.onCreateShow(title);
        setView((now) => ({ ...now, show: { kind: "ready", title } }));
      }}
      onWrite={() => {
        rest.onWrite();
        setView((now) => ({ ...now, file: "current" }));
      }}
    />
  );
}

const meta: Meta<typeof FeedSection> = {
  title: "Stages/Deliver/Podcast listing",
  component: FeedSection,
  tags: ["autodocs"],
  render: (args) => <Live {...args} />,
  args: {
    view: READY,
    itemXml: ITEM_XML,
    onEdit: fn(),
    onCreateShow: fn(),
    onFix: fn(),
    onOpenSource: fn(),
    onCopyNotes: fn(),
    onCopyItem: fn(),
    onWrite: fn(),
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
          "The episode as a podcast app will show it, with the feed file behind it. No inputs show until you click a value. An Auto mark sits on a value a click would pin, Agent marks a pin an agent made, and your own pins carry no mark. A missing value says what it needs and carries the button that supplies it. The strip leads with the first thing left, Checks keeps the rest closed, and the footer writes the feed file.\n\n**Not mounted yet.** Deliver does not render this section until the listing API lands.",
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
    await expect(view.getByText("Transcript SRT · VTT")).toBeInTheDocument();
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
  },
};

export const DriftedPin: Story = {
  args: { view: DRIFTED },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText("Chapters changed since you edited this"),
    ).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Keep mine" }),
    ).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Use new" }),
    ).toBeInTheDocument();
  },
};

export const Pending: Story = {
  args: { view: PENDING },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("2 things left")).toBeInTheDocument();
    await expect(
      view.getAllByRole("button", { name: "Add address" }),
    ).toHaveLength(2);
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

export const Checks: Story = {
  args: { view: CHECKS },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText("2 things left")).toBeInTheDocument();
    await expect(
      view.getByRole("button", { name: "Copy item" }),
    ).toBeDisabled();
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
