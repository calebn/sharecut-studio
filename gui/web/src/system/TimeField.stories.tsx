import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { TimeField } from "./TimeField";

function Field({ start = 12, reset }: { start?: number; reset?: number }) {
  const [value, setValue] = useState(start);
  return (
    <TimeField
      label="Gain"
      unit="dB"
      value={value}
      min={-24}
      max={24}
      step={0.5}
      defaultValue={reset}
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
          "A number with its unit. Drag the label, type and press Enter, or step with the arrows (Shift ×10, Alt ×0.1). Esc puts the old value back, and a dot appears when the value is not the default. Used by the Deliver chapter times and the Part In and Out.\n\n**Motion.** Animations come later: the reset dot scales in with `--motion-hover`.",
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

export const WithReset: Story = {
  render: () => <Field start={6} reset={0} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole("button", { name: "Reset Gain" }));
    await expect(view.getByRole("textbox", { name: "Gain" })).toHaveValue("0");
    await expect(view.queryByRole("button", { name: "Reset Gain" })).toBeNull();
  },
};
