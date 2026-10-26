import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { PersonAvatar, type PersonAvatarSize, PersonTile } from "./Person";
import { PERSON_STATES, type PersonTileState } from "./personStates";
import { PEOPLE } from "./prepareFixtures";

const meta: Meta<typeof PersonTile> = {
  title: "System/Person",
  component: PersonTile,
  tags: ["autodocs"],
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
          "A person as initials on their colour, in four sizes (20, 24, 28, 32), and as a tile that says their state in a glyph and plain words: Waiting, Joined, Didn't join, Connection lost, Weak signal, Saving, Saved. The avatar is hidden from assistive tech because the name is printed beside it. Only the empty tile is a button.\n\n**Motion.** None in this slice. The speaking ring and its level are not drawn yet.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof PersonTile>;

const SIZES: PersonAvatarSize[] = [20, 24, 28, 32];

export const AvatarSizes: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      {PEOPLE.map((person) => (
        <div
          key={person.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-4)",
            flexWrap: "wrap",
          }}
        >
          {SIZES.map((size) => (
            <PersonAvatar key={size} person={person} size={size} />
          ))}
          <span>{person.name}</span>
        </div>
      ))}
    </div>
  ),
};

const STATES = Object.keys(PERSON_STATES) as PersonTileState[];

export const TileStates: Story = {
  render: () => (
    <div className="sys-person-grid">
      {STATES.map((state, index) => (
        <PersonTile
          key={state}
          state={state}
          person={{
            name: PEOPLE[index % PEOPLE.length].name,
            colorIndex: index,
          }}
        />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const { text } of Object.values(PERSON_STATES)) {
      await expect(canvas.getByText(text)).toBeVisible();
    }
  },
};

export const Empty: Story = {
  args: { onInvite: fn() },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Invite" }),
    );
    await expect(
      (args as { onInvite: () => void }).onInvite,
    ).toHaveBeenCalledOnce();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "mobile360", isRotated: false } },
  render: () => (
    <div className="sys-person-grid">
      <PersonTile person={PEOPLE[0]} state="joined" />
      <PersonTile person={PEOPLE[1]} state="weak" />
      <PersonTile person={PEOPLE[2]} state="lost" />
      <PersonTile onInvite={fn()} />
    </div>
  ),
};
