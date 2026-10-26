import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { TimeField } from "./TimeField";

function Field() {
  const [value, setValue] = useState(12);
  return (
    <TimeField
      label="Gain"
      value={value}
      min={-24}
      max={24}
      step={0.5}
      onChange={setValue}
    />
  );
}

const meta: Meta<typeof TimeField> = {
  title: "System/TimeField",
  component: TimeField,
  tags: ["autodocs"],
  render: () => <Field />,
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
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
          "A number. Drag the label, type and press Enter, or step with the arrows (Shift ×10, Alt ×0.1). Esc puts the old value back. Used by the Deliver chapter times and the Part In and Out.\n\n**Motion.** Animations come later.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TimeField>;

export const Plain: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox", { name: "Gain" });
    await userEvent.click(input);
    await userEvent.keyboard("{ArrowUp}");
    await expect(input).toHaveValue("12.5");
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await expect(input).toHaveValue("7.5");
    await userEvent.clear(input);
    await userEvent.type(input, "30{Enter}");
    await expect(input).toHaveValue("24");
    await userEvent.clear(input);
    await userEvent.type(input, "3{Escape}");
    await expect(input).toHaveValue("24");
  },
};
