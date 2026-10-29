import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Avatar } from "../ui";
import { Cover } from "./Cover";
import { PersonAvatar } from "./Person";

const meta: Meta<typeof Cover> = {
  title: "System/Cover",
  component: Cover,
  tags: ["autodocs"],
  args: {
    size: "page",
    glyph: "inbox",
    title: "Nothing to decide",
    children:
      "Every suggestion has an answer. New ones appear here as you edit.",
    secondary: { label: "Back to Edit", onClick: fn() },
  },
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'The one "nothing to show here" layout: a 48 px case glyph, a 20/24 title, one sentence, at most one primary and one text button. Page size adds the 32 px symbol; on phone the text block starts at 30% of the height and the primary is pinned in the thumb zone. Renders a `<section>`, never `<main>`. Never server JSON. The Record covers (Invalid, InviteClosed, Full, Ended, EndedWithLocalRecording, EndedDownloaded and their phone forms) speak plainly about a link that opens no room, a room that is full and a session that has ended.\n\n**Motion.** The block fades in with `--motion-state` after the Skeleton hands over; not implemented in this slice.',
      },
    },
  },
};

// The Record covers (invalid link, room full, session ended). Their words are
// the guest's, never the server's; the glyphs are the nearest in the icon table
// (the spec's slashed door, tile grid and closed door are not in it yet).
const OCCUPANTS = [
  { name: "Maya Okafor", colorIndex: 0 },
  { name: "Anneke de Vries", colorIndex: 1 },
  { name: "Rosa Diaz", colorIndex: 2 },
  { name: "Joss", colorIndex: 3 },
];

export default meta;
type Story = StoryObj<typeof Cover>;

/** The Cover's own contract: a named section, its heading, exactly these buttons. */
async function expectCover(
  canvasElement: HTMLElement,
  title: string,
  buttons: readonly string[],
  mark: boolean,
) {
  const canvas = within(canvasElement);
  const section = canvas.getByRole("region", { name: title });
  await expect(
    within(section).getByRole("heading", { name: title }),
  ).toBeVisible();
  await expect(
    within(section)
      .queryAllByRole("button")
      .map((button) => button.textContent?.trim()),
  ).toEqual([...buttons]);
  await expect(!!section.querySelector(".sys-cover-mark")).toBe(mark);
  return section;
}

export const Empty: Story = {
  args: { primary: { label: "Review suggestions", onClick: fn() } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Nothing to decide" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Review suggestions" }),
    );
    await expect(args.primary?.onClick).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole("button", { name: "Back to Edit" }));
    await expect(args.secondary?.onClick).toHaveBeenCalledTimes(1);
  },
};

export const BadLink: Story = {
  args: {
    glyph: "octagon-alert",
    title: "This link does not work",
    children: "Ask the host for a new one.",
    primary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(
      canvasElement,
      "This link does not work",
      ["Back to Edit"],
      true,
    );
  },
};

export const LinkEnded: Story = {
  args: {
    glyph: "door-open",
    title: "This link has ended",
    children: "The host stopped sharing the project.",
  },
  play: async ({ canvasElement }) => {
    await expectCover(
      canvasElement,
      "This link has ended",
      ["Back to Edit"],
      true,
    );
  },
};

export const EndedWithRecording: Story = {
  args: {
    glyph: "door-open",
    title: "The session ended",
    children: "Your local recording is safe on this device.",
    primary: { label: "Save my recording", onClick: fn() },
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(
      canvasElement,
      "The session ended",
      ["Save my recording"],
      true,
    );
  },
};

export const RoomFull: Story = {
  args: {
    glyph: "headphones",
    title: "The room is full",
    children: "Try again in a minute.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
    extra: (
      <span style={{ display: "inline-flex", gap: "var(--space-1)" }}>
        <Avatar name="Maya Chen" colorIndex={0} />
        <Avatar name="Rosa Diaz" colorIndex={1} />
        <Avatar name="Tom Park" colorIndex={2} />
      </span>
    ),
  },
  play: async ({ canvasElement }) => {
    const section = await expectCover(
      canvasElement,
      "The room is full",
      ["Try again"],
      true,
    );
    await expect(section.querySelectorAll(".ui-avatar")).toHaveLength(3);
  },
};

export const HostAsleep: Story = {
  args: {
    glyph: "cloud-off",
    title: "The host is away",
    children: "We will let you in when they are back.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(canvasElement, "The host is away", ["Try again"], true);
  },
};

export const NotServedHere: Story = {
  args: {
    glyph: "cloud-off",
    title: "This is not available here",
    children: "Open the project in the desktop app to use this.",
    primary: undefined,
    secondary: { label: "Back to Home", onClick: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This is not available here" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: /Try again/ }),
    ).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Back to Home" }));
    await expect(args.secondary?.onClick).toHaveBeenCalledTimes(1);
  },
};

export const RegionFailed: Story = {
  args: {
    size: "region",
    glyph: "octagon-alert",
    title: "This part did not load",
    children: "The rest of the project is fine.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(
      canvasElement,
      "This part did not load",
      ["Try again"],
      false,
    );
  },
};

export const Region: Story = {
  args: {
    size: "region",
    glyph: "text-search",
    title: "No matches",
    children: "Nothing in the transcript matches that search.",
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(canvasElement, "No matches", [], false);
  },
};

export const Phone: Story = {
  args: {
    primary: { label: "Go to Edit", onClick: fn() },
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expectCover(canvasElement, "Nothing to decide", ["Go to Edit"], true);
  },
};

const RECORD_INVALID: Story = {
  args: {
    glyph: "octagon-alert",
    title: "This link doesn't open a room",
    children: "Ask the person who invited you for a new link.",
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "This link doesn't open a room" }),
    ).toBeVisible();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const Invalid: Story = { ...RECORD_INVALID };
export const InvalidPhone: Story = { ...RECORD_INVALID };

const RECORD_CLOSED: Story = {
  args: {
    glyph: "door-open",
    title: "Invite link closed",
    children:
      "The host closed this invite link to new participants. Ask the host for a new link.",
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Invite link closed" }),
    ).toBeVisible();
    await expect(canvas.queryAllByRole("button")).toHaveLength(0);
  },
};

export const InviteClosed: Story = { ...RECORD_CLOSED };
export const InviteClosedPhone: Story = { ...RECORD_CLOSED };

export const InviteClosedWithLocalRecording: Story = {
  args: {
    glyph: "door-open",
    title: "Invite link closed",
    children:
      "Maya closed this invite link. Your recording is safe on this device. Save it and send it to Maya, or ask for a new link.",
    primary: { label: "Save my recording", onClick: fn() },
    secondary: { label: "Try saving again", onClick: fn() },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Invite link closed" }),
    ).toBeVisible();
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

const RECORD_FULL: Story = {
  args: {
    glyph: "user",
    title: "The room is full",
    children: "Ask Maya to make space or send you a new link.",
    primary: { label: "Try again", onClick: fn() },
    secondary: undefined,
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

export const Full: Story = { ...RECORD_FULL };
export const FullPhone: Story = { ...RECORD_FULL };

const RECORD_ENDED: Story = {
  args: {
    glyph: "door-open",
    title: "This session has ended",
    children: "Thanks for recording.",
    secondary: undefined,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryAllByRole("button")).toHaveLength(
      0,
    );
  },
};

export const Ended: Story = { ...RECORD_ENDED };

const RECORD_LOCAL: Story = {
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

export const EndedWithLocalRecording: Story = { ...RECORD_LOCAL };
export const EndedPhone: Story = { ...RECORD_LOCAL };

export const EndedBusy: Story = {
  args: {
    ...RECORD_LOCAL.args,
    primary: { label: "Save my recording", onClick: fn(), busy: true },
  },
  play: async ({ canvasElement }) => {
    const save = within(canvasElement).getByRole("button", {
      name: "Save my recording",
    });
    await expect(save).toBeDisabled();
    await expect(save).toHaveAttribute("aria-busy", "true");
  },
};

export const EndedDownloaded: Story = {
  args: {
    glyph: "circle-check",
    title: "Saved to Downloads",
    children: "Send the file to Maya.",
    primary: undefined,
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
