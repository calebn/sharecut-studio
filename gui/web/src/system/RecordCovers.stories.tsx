import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Cover } from "./Cover";
import { PersonAvatar } from "./Person";

const OCCUPANTS = [
  { name: "Maya Okafor", colorIndex: 0 },
  { name: "Anneke de Vries", colorIndex: 1 },
  { name: "Rosa Diaz", colorIndex: 2 },
  { name: "Joss", colorIndex: 3 },
];

const meta: Meta<typeof Cover> = {
  title: "Stages/Record/Covers",
  component: Cover,
  tags: ["autodocs"],
  args: { size: "page", glyph: "octagon-alert", title: "", children: "" },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "The three Record covers on the shared Cover: a link that does not open a room, a room that is full, and a session that has ended (with or without a recording still on this device). Words are the guest's, never the server's. The glyphs come from the one icon table; the spec's slashed door, tile grid and closed door are not in it yet, so the case glyphs here are the nearest existing ones.\n\n**Motion.** None yet. Later: the block fades in with `--motion-state`, as on every Cover.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Cover>;

const INVALID: Story = {
  args: {
    glyph: "octagon-alert",
    title: "This link doesn't open a room",
    children: "Ask the person who invited you for a new link.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This link doesn't open a room" }),
    ).toBeVisible();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const Invalid: Story = { ...INVALID };
export const InvalidPhone: Story = { ...INVALID };

const FULL: Story = {
  args: {
    glyph: "user",
    title: "The room is full",
    children: "Ask Maya to make space or send you a new link.",
    primary: { label: "Try again", onClick: fn() },
    extra: (
      <span className="sys-cover-people">
        {OCCUPANTS.map((person) => (
          <PersonAvatar key={person.name} person={person} size={32} />
        ))}
        <span className="sr-only">
          Maya, Anneke, Rosa and Joss are in the room.
        </span>
      </span>
    ),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.primary?.onClick).toHaveBeenCalledTimes(1);
  },
};

export const Full: Story = { ...FULL };
export const FullPhone: Story = { ...FULL };

const ENDED: Story = {
  args: {
    glyph: "door-open",
    title: "This session has ended",
    children: "Thanks for recording.",
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryAllByRole("button")).toHaveLength(
      0,
    );
  },
};

export const Ended: Story = { ...ENDED };

const LOCAL: Story = {
  args: {
    glyph: "door-open",
    title: "Your recording didn't finish saving",
    children: "It's safe on this device. Save it and send it to Maya.",
    primary: { label: "Save my recording", onClick: fn() },
    secondary: { label: "Try saving again", onClick: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Save my recording" }),
    );
    await expect(args.primary?.onClick).toHaveBeenCalledTimes(1);
    await userEvent.click(
      canvas.getByRole("button", { name: "Try saving again" }),
    );
    await expect(args.secondary?.onClick).toHaveBeenCalledTimes(1);
  },
};

export const EndedWithLocalRecording: Story = { ...LOCAL };
export const EndedPhone: Story = { ...LOCAL };

export const EndedDownloaded: Story = {
  args: {
    glyph: "circle-check",
    title: "Saved to Downloads",
    children: "Send the file to Maya.",
    secondary: { label: "Save it again", onClick: fn() },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Saved to Downloads" }),
    ).toBeVisible();
    await expect(canvas.getAllByRole("button")).toHaveLength(1);
  },
};
