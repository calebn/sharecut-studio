import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { PersonPicker, type PersonPickerProps } from "./PersonPicker";
import { ALIKE, PEOPLE } from "./prepareFixtures";

const meta: Meta<typeof PersonPicker> = {
  title: "System/PersonPicker",
  component: PersonPicker,
  tags: ["autodocs"],
  args: { people: PEOPLE, onPick: fn(), onRename: undefined },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "28rem" }}>
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
          'Who is this voice? One native radio per person in a group of that name, so arrows and the single tab stop come from the browser. "Fix text" is a separate button beside the radio, never inside it. Two people with the same name carry a detail line. Rows are 44 px tall on a phone.\n\n**Motion.** None.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PersonPicker>;

function Picking(props: PersonPickerProps) {
  const [current, setCurrent] = useState(props.currentId);
  return (
    <PersonPicker
      {...props}
      currentId={current}
      onPick={(id) => {
        setCurrent(id);
        props.onPick(id);
      }}
    />
  );
}

export const NoneYet: Story = {
  render: (args) => <Picking {...args} />,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole("radiogroup", {
      name: "Who is this voice?",
    });
    await expect(group).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: /^Anneke/ }));
    await expect(args.onPick).toHaveBeenCalledWith("anneke");
    await expect(canvas.getByRole("radio", { name: /^Anneke/ })).toBeChecked();
  },
};

export const Chosen: Story = {
  args: { currentId: "maya" },
  render: (args) => <Picking {...args} />,
};

export const WithFixText: Story = {
  args: { currentId: "joss", onRename: fn() },
  render: (args) => <Picking {...args} />,
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getAllByRole("button", { name: /^Fix text/ })[0],
    );
    await expect(args.onRename).toHaveBeenCalledWith("maya");
  },
};

export const NamedAlike: Story = {
  args: { people: ALIKE, currentId: "sam-b", onRename: fn() },
  render: (args) => <Picking {...args} />,
};

export const Phone: Story = {
  args: { currentId: "anneke", onRename: fn() },
  globals: { viewport: { value: "mobile360", isRotated: false } },
  render: (args) => <Picking {...args} />,
};
