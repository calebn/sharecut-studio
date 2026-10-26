import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  menuStoryDecorator,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import {
  type SessionTarget,
  SessionTargetChip,
  type SessionTargetChipProps,
} from "./SessionTargetChip";

const meta: Meta<typeof SessionTargetChip> = {
  title: "System/SessionTargetChip",
  component: SessionTargetChip,
  tags: ["autodocs"],
  args: { target: "start", onTarget: fn() },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    ...portaledOverlayParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'Where a session goes in the episode, in words. Before the first take it is a menu: "Starts the episode" or "At the end". After it, the chip is locked: a lock icon and "Set when the first take landed" in the text, not a control and not a tab stop. The text wraps and is never cut off.\n\n**Motion.** The menu drops in through `ui/Menu`. Nothing else moves.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof SessionTargetChip>;

function Choosing(props: SessionTargetChipProps) {
  const [target, setTarget] = useState<SessionTarget>(props.target);
  return (
    <SessionTargetChip
      {...props}
      target={target}
      onTarget={(next) => {
        setTarget(next);
        props.onTarget?.(next);
      }}
    />
  );
}

export const Menu: Story = {
  render: (args) => <Choosing {...args} />,
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: Starts the episode",
      }),
    );
    const body = within(document.body);
    await userEvent.click(
      await body.findByRole("menuitem", { name: "At the end" }),
    );
    await expect(args.onTarget).toHaveBeenCalledWith("end");
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: At the end",
      }),
    ).toBeVisible();
  },
};

export const MenuOpen: Story = {
  decorators: [menuStoryDecorator],
  render: (args) => <Choosing {...args} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: Starts the episode",
      }),
    );
    await expect(await within(document.body).findByRole("menu")).toBeVisible();
  },
};

export const Locked: Story = {
  args: { locked: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Set when the first take landed"),
    ).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Phone: Story = {
  args: { locked: true, target: "end" },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
