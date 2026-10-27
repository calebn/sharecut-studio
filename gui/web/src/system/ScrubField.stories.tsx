import type { Meta, StoryObj } from "@storybook/react-vite";
import { type CSSProperties, useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ScrubField, type ScrubFieldProps } from "./ScrubField";

function Live(args: ScrubFieldProps) {
  const [committed, setCommitted] = useState(args.value);
  const [shown, setShown] = useState(args.value);
  return (
    <ScrubField
      {...args}
      value={shown}
      onPreview={(next) => {
        setShown(next);
        args.onPreview?.(next);
      }}
      onCommit={(next) => {
        setCommitted(next);
        setShown(next);
        args.onCommit(next);
      }}
      onCancel={() => {
        setShown(committed);
        args.onCancel?.();
      }}
    />
  );
}

const row: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 12rem)",
  alignItems: "center",
  gap: "var(--space-4)",
  maxInlineSize: "24rem",
};

const meta: Meta<typeof ScrubField> = {
  title: "System/ScrubField",
  component: ScrubField,
  tags: ["autodocs"],
  args: {
    label: "Offset",
    unit: "ms",
    value: 120,
    min: 0,
    max: 500,
    onCommit: fn(),
    onPreview: fn(),
    onCancel: fn(),
  },
  render: (args) => (
    <div style={{ padding: "var(--space-5)" }}>
      <div style={row}>
        <span>{args.label}</span>
        <Live {...args} />
      </div>
    </div>
  ),
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A number with its unit in Plex Mono (design-system element 11). **Drag** sideways to change it, one step per pixel, Shift for ten times and Alt for a tenth. **Click** or press Enter to type; Enter commits, Escape reverts. **Arrow keys** step it with the same modifiers, and Home and End jump to the range ends. A gesture fires `onPreview` as it moves and `onCommit` once when it ends, so one drag, key press or typed value is one undo step; Escape during a drag calls `onCancel`. A reset dot shows while the value differs from its default. The **track** variant draws the allowed range under the number, and the **level** variant fills the field up to the value. A bad number keeps the field open and names the range. Alt needs a decimal place to show: give a whole-number field `decimals` 1. The field is a `spinbutton`, so assistive tech reads the value and unit; drag, hold and the reset dot have the keyboard and typing as their equivalents. Under a coarse pointer the field and the reset dot grow to 44 px, and the text is 16 px so iOS does not zoom.\n\n**Motion.** None. The value follows the pointer without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScrubField>;

const field = (root: HTMLElement) =>
  within(root).getByRole("spinbutton", { name: "Offset" });

export const Plain: Story = {
  args: { variant: "plain", min: undefined, max: undefined },
};

export const WithTrack: Story = {
  args: { variant: "track", min: 0, max: 500 },
  play: async ({ canvasElement }) => {
    await expect(field(canvasElement)).toHaveAttribute("aria-valuemax", "500");
  },
};

export const LevelBar: Story = {
  args: {
    variant: "level",
    label: "Offset",
    unit: "dB",
    value: -12,
    min: -60,
    max: 6,
    step: 0.5,
    decimals: 1,
  },
};

export const Keyboard: Story = {
  args: { decimals: 1 },
  play: async ({ args, canvasElement }) => {
    const user = userEvent.setup();
    field(canvasElement).focus();
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect(args.onCommit).toHaveBeenNthCalledWith(1, 121);
    await expect(args.onCommit).toHaveBeenNthCalledWith(2, 131);
  },
};

export const Typing: Story = {
  play: async ({ args, canvasElement }) => {
    const user = userEvent.setup();
    await user.click(field(canvasElement));
    const input = within(canvasElement).getByRole("textbox", {
      name: "Offset",
    });
    await user.clear(input);
    await user.type(input, "40{Enter}");
    await expect(args.onCommit).toHaveBeenCalledWith(40);
  },
};

export const WithResetDot: Story = {
  args: { defaultValue: 0 },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Reset Offset to 0 ms",
      }),
    );
    await expect(args.onCommit).toHaveBeenCalledWith(0);
  },
};

export const Empty: Story = {
  args: { value: null, defaultValue: 0 },
  play: async ({ canvasElement }) => {
    await expect(field(canvasElement)).toHaveTextContent("Not set");
  },
};

export const InvalidTypedValue: Story = {
  play: async ({ canvasElement }) => {
    const user = userEvent.setup();
    await user.click(field(canvasElement));
    const input = within(canvasElement).getByRole("textbox", {
      name: "Offset",
    });
    await user.clear(input);
    await user.type(input, "900{Enter}");
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "Enter a number from 0 to 500 ms",
    );
  },
};

export const ErrorFromOutside: Story = {
  args: { error: "The roll cannot pass the next cut" },
  play: async ({ canvasElement }) => {
    await expect(field(canvasElement)).toHaveAccessibleDescription(
      "The roll cannot pass the next cut",
    );
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true, defaultValue: 0 },
  play: async ({ canvasElement }) => {
    await expect(field(canvasElement)).toHaveAttribute("aria-readonly", "true");
    await expect(within(canvasElement).queryByRole("button")).toBeNull();
  },
};

export const PhoneMixRows: Story = {
  render: () => (
    <div
      style={{
        inlineSize: "22.5rem",
        padding: "var(--space-5)",
        display: "grid",
        gap: "var(--space-4)",
      }}
    >
      {[
        { name: "Mira", value: -6 },
        { name: "Jonas", value: -9.5 },
        { name: "Music", value: -18 },
      ].map(({ name, value }) => (
        <div
          key={name}
          style={{ ...row, gridTemplateColumns: "4rem minmax(0, 1fr)" }}
        >
          <span>{name}</span>
          <Live
            variant="level"
            label={`${name} level`}
            unit="dB"
            value={value}
            min={-60}
            max={6}
            step={0.5}
            decimals={1}
            defaultValue={0}
            onCommit={fn()}
          />
        </div>
      ))}
    </div>
  ),
};
