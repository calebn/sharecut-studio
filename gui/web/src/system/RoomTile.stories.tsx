import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { ListenerAvatar, ListenerRow, RoomTile } from "./RoomTile";

const MAYA = { name: "Maya Okafor", colorIndex: 0 };
const ANNEKE = { name: "Anneke de Vries", colorIndex: 1 };
const JOSS = { name: "Joss", colorIndex: 2 };
const JON = { name: "Jon", colorIndex: 3 };

const LIVE = { presence: "live", person: MAYA } as const;

const meta: Meta<typeof RoomTile> = {
  title: "Stages/Record/PersonTile",
  component: RoomTile,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "22.5rem",
        }}
      >
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
          "The live-room form of the person tile: 4:3, an avatar whose ring is the live level (3 px at silence, 8 px at peak, set from a 0 to 1 `level`), the name bottom-left, a 16 px glyph cluster bottom-right (muted, signal, ear for listeners) and badges top-right (clip count, alert triangle). Every state is also in words or the tile's accessible name; the level is never announced. Presentational: state in, nothing out except Invite.\n\n**Motion.** Animations come later. The ring follows `level` as given, with no easing, no speaking pulse and no clip tick.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RoomTile>;

const tileByName = (root: HTMLElement, name: string | RegExp) =>
  within(root).getByRole("group", { name });

export const PlaceholderInvite: Story = {
  args: { presence: "placeholder", onInvite: fn() },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Invite" }),
    );
    if (args.presence !== "placeholder") throw new Error("wrong story args");
    await expect(args.onInvite).toHaveBeenCalledOnce();
  },
};

export const Joining: Story = {
  args: { presence: "joining", person: ANNEKE },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Joining…")).toBeVisible();
    await expect(tileByName(canvasElement, /Anneke de Vries/)).toBeVisible();
  },
};

export const Live: Story = {
  args: { ...LIVE, level: 0.3 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Maya Okafor")).toBeVisible();
    await expect(
      within(canvasElement).getByTitle("Good connection"),
    ).toBeInTheDocument();
  },
};

export const Speaking: Story = {
  args: { ...LIVE, level: 0.8, speaking: true },
  play: async ({ canvasElement }) => {
    await expect(
      tileByName(canvasElement, "Maya Okafor, speaking"),
    ).toBeVisible();
  },
};

export const Muted: Story = {
  args: { ...LIVE, muted: true, level: 0.6 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTitle("Muted")).toBeInTheDocument();
    await expect(tileByName(canvasElement, /muted/)).toBeVisible();
  },
};

export const Clipping: Story = {
  args: {
    ...LIVE,
    person: JON,
    level: 1,
    speaking: true,
    clipped: 3,
    alert: true,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("3")).toBeVisible();
    await expect(tileByName(canvasElement, /3 clips/)).toBeVisible();
    await expect(tileByName(canvasElement, /needs attention/)).toBeVisible();
  },
};

export const Weak: Story = {
  args: { ...LIVE, person: ANNEKE, level: 0.2, connection: "weak" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByTitle("Weak signal"),
    ).toBeInTheDocument();
    await expect(tileByName(canvasElement, /Weak signal/)).toBeVisible();
  },
};

export const Lost: Story = {
  args: { ...LIVE, person: JOSS, connection: "lost" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Reconnecting…"),
    ).toBeVisible();
  },
};

export const Saving: Story = {
  args: { ...LIVE, saving: { done: 64, total: 100 } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Saving 64%")).toBeVisible();
  },
};

export const Saved: Story = {
  args: { ...LIVE, saving: "saved" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Saved")).toBeVisible();
  },
};

export const Failed: Story = {
  args: { ...LIVE, saving: "failed" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Couldn't save"),
    ).toBeVisible();
    await expect(within(canvasElement).getByText("!")).toBeVisible();
  },
};

export const Declined: Story = {
  args: { presence: "declined", person: JOSS },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Declined")).toBeVisible();
  },
};

export const Left: Story = {
  args: { presence: "left", person: JON },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Left")).toBeVisible();
  },
};

export const Self: Story = {
  args: { ...LIVE, level: 0.5, isMe: true },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".sys-room-meter")).not.toBeNull();
    await expect(within(canvasElement).getByText("Maya Okafor")).toBeVisible();
  },
};

export const ListenerRowStory: Story = {
  name: "ListenerRow",
  render: () => (
    <ListenerRow>
      <ListenerAvatar person={MAYA} label="You" />
      <ListenerAvatar person={JON} />
    </ListenerRow>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("list", { name: "Listening" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("You, listening")).toBeInTheDocument();
    await expect(canvas.getByText("Jon, listening")).toBeInTheDocument();
  },
};

const FOUR = (
  <div className="sys-room-grid">
    <RoomTile presence="live" person={MAYA} isMe level={0.5} speaking />
    <RoomTile presence="live" person={ANNEKE} level={0.2} connection="weak" />
    <RoomTile presence="live" person={JOSS} muted clipped={2} />
    <RoomTile presence="joining" person={JON} />
  </div>
);

const STATUS_ROW = (
  <div className="sys-room-grid">
    <RoomTile
      presence="live"
      person={MAYA}
      isMe
      saving={{ done: 3, total: 4 }}
    />
    <RoomTile presence="live" person={JOSS} connection="lost" />
    <RoomTile presence="live" person={ANNEKE} isMe saving="failed" />
    <RoomTile presence="live" person={JON} isMe connection="lost" />
  </div>
);

export const FourPeopleGrid: Story = {
  render: () => FOUR,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("group")).toHaveLength(4);
    await expect(within(canvasElement).getByText("Joining…")).toBeVisible();
  },
};

export const PhoneWidth: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  // The default decorator caps the width at 22.5rem, which would hide the 390 container.
  decorators: [],
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: "var(--space-5)",
      }}
    >
      {[360, 390].map((width) => (
        <div
          key={width}
          style={{
            inlineSize: `${width / 16}rem`,
            maxInlineSize: "100%",
            paddingInline: "var(--space-5)",
            boxSizing: "border-box",
          }}
        >
          {FOUR}
          {STATUS_ROW}
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const tiles = within(canvasElement).getAllByRole("group");
    await expect(tiles).toHaveLength(16);
    for (const tile of tiles) {
      // jsdom has no layout, so clientHeight is 0 there and the check is skipped.
      if (tile.clientHeight > 0) {
        await expect(tile.scrollHeight).toBeLessThanOrEqual(
          tile.clientHeight + 1,
        );
      }
    }
    await expect(within(canvasElement).getAllByText("Joining…")).toHaveLength(
      2,
    );
  },
};
