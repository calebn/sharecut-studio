import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  menuStoryDecorator,
  portaledOverlayParameters,
  viewportStoryParameters,
} from "../storybook/storyLayout";
import {
  type PrepareTarget,
  SessionTargetChip,
  type SessionTargetChipProps,
  type SessionTargetView,
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
  const [target, setTarget] = useState(props.target);
  if (typeof props.target === "string") {
    return (
      <SessionTargetChip
        {...props}
        target={target as PrepareTarget}
        onTarget={(next) => {
          setTarget(next);
          props.onTarget?.(next);
        }}
      />
    );
  }
  return (
    <SessionTargetChip
      {...props}
      target={target as SessionTargetView}
      onChange={(next) => {
        setTarget(next);
        props.onChange?.(next);
      }}
    />
  );
}

const MID_EPISODE: SessionTargetView = { kind: "end", afterSec: 3130 };

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
      await body.findByRole("menuitemradio", { name: "At the end" }),
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

export const Placements: Story = {
  args: {
    target: MID_EPISODE,
    onChange: fn(),
    endAfterSec: 3130,
    playheadSec: 724,
    selection: { fromSec: 724, toSec: 749 },
  },
  render: (args) => <Choosing {...args} />,
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: Lands at the end · after 52:10",
      }),
    );
    const body = within(document.body);
    const items = await body.findAllByRole("menuitemradio");
    await expect(
      items
        .filter((item) => item.ariaChecked === "true")
        .map((item) => item.textContent),
    ).toEqual(["At the end"]);
    await expect(items.map((item) => item.textContent)).toEqual([
      "At the end",
      "At the start",
      "At the playhead (12:04)",
      "Replace selection",
    ]);
    await userEvent.click(
      body.getByRole("menuitemradio", { name: "Replace selection" }),
    );
    await expect(args.onChange).toHaveBeenCalledWith({
      kind: "replace",
      fromSec: 724,
      toSec: 749,
    });
    await waitFor(() => expect(body.queryByRole("menu")).toBeNull());
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: Replaces 12:04-12:29",
      }),
    ).toBeVisible();
  },
};

export const EmptyProject: Story = {
  args: { target: { kind: "end" }, onChange: fn() },
  render: (args) => <Choosing {...args} />,
  parameters: {
    docs: {
      description: {
        story:
          'An end with no clip to follow reads "Starts the episode" and draws the start glyph; the menu still has the end checked.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Where this session goes: Starts the episode",
      }),
    ).toBeVisible();
  },
};

export const Glyphs: Story = {
  args: { locked: false },
  render: () => (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--space-3)",
        alignItems: "flex-start",
      }}
    >
      <SessionTargetChip target={{ kind: "end", afterSec: 3130 }} />
      <SessionTargetChip target={{ kind: "start" }} />
      <SessionTargetChip target={{ kind: "insert", atSec: 724 }} />
      <SessionTargetChip
        target={{ kind: "replace", fromSec: 724, toSec: 749 }}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "One placement glyph per kind (end, start, insert, replace) ahead of the words. The glyph is decorative: the text carries the meaning, and a locked chip shows only the lock.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("button")).toHaveLength(4);
  },
};

export const NoEditState: Story = {
  args: { target: MID_EPISODE, onChange: fn(), endAfterSec: 3130 },
  render: (args) => <Choosing {...args} />,
};

export const LockedInsert: Story = {
  args: { target: { kind: "insert", atSec: 724 }, locked: true },
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
