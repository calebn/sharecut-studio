import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ChipInput, type ChipInputProps } from "./ChipInput";

const meta: Meta<typeof ChipInput> = {
  title: "System/ChipInput",
  component: ChipInput,
  tags: ["autodocs"],
  args: {
    speakers: ["Anneke", "Maya"],
    terms: ["Okafor", "Utrecht"],
    reservedChars: 0,
    onTermsChange: () => undefined,
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "32rem" }}>
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
          'Names and terms to listen for. Speakers lead and are fixed (a user icon, no remove). Terms are removable. Enter or a comma adds one, a paste with commas splits it, an empty Enter does nothing, and Backspace in an empty field removes the last term. Matching ignores case, so "okafor" is the same as "Okafor". The budget is 372 characters of speakers and terms joined with ", "; "N left" shows within 40, and at the limit the field stays typeable but refuses the add and says so. Announcements come only at 40 left, 0 left, a refused add and a duplicate.\n\n**Motion.** None.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ChipInput>;

function Live(props: ChipInputProps) {
  const [terms, setTerms] = useState<string[]>([...props.terms]);
  return <ChipInput {...props} terms={terms} onTermsChange={setTerms} />;
}

export const Default: Story = {
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("Names and terms"),
      "Rotterdam,",
    );
    await expect(
      canvas.getByRole("button", { name: "Remove Rotterdam" }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  args: { speakers: [], terms: [] },
  render: (args) => <Live {...args} />,
};

export const Duplicate: Story = {
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("Names and terms"),
      "okafor{Enter}",
    );
    await expect(
      canvas.getAllByText("okafor is already there.")[0],
    ).toBeVisible();
  },
};

export const NearLimit: Story = {
  args: {
    terms: ["a".repeat(90), "b".repeat(90), "c".repeat(90), "d".repeat(60)],
  },
  render: (args) => <Live {...args} />,
};

export const AtLimit: Story = {
  args: {
    terms: ["a".repeat(100), "b".repeat(100), "c".repeat(100), "d".repeat(54)],
  },
  render: (args) => <Live {...args} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("Names and terms"),
      "toolong{Enter}",
    );
    await expect(
      canvas.getAllByText("That is the limit. Remove a term to add more.")[0],
    ).toBeVisible();
  },
};

export const Phone: Story = {
  args: { terms: ["Okafor", "Utrecht", "Rotterdam", "Keukenhof"] },
  render: (args) => <Live {...args} />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
