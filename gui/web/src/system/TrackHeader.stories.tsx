import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { TrackHeader } from "./TrackHeader";

const meta: Meta<typeof TrackHeader> = {
  title: "System/TrackHeader",
  component: TrackHeader,
  tags: ["autodocs"],
  args: {
    id: "track-maya",
    name: "Maya Okafor",
    colorIndex: 0,
    level: 0,
    mute: "off",
    solo: false,
    onSelect: fn(),
    onMute: fn(),
    onSolo: fn(),
    onLevel: fn(),
    onMove: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ margin: "var(--space-5)" }}>
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
          "The left edge of a track (design-system element 16). Row one is the 28 px avatar in the track's colour with a ring that lights to the live level, and the name. Row two, shown on hover, on focus and whenever something is set, holds Mute (`volume-x`), Solo (`headphones`) and the level Scrub field. Muted shows a filled `volume-x` and greys the avatar and name; muted for you alone is dashed; a track silent only because another is soloed (an implied mute) is a dashed, unpressed Mute that says why; soloed shows a filled `headphones`. While the stem rebuilds the avatar's ring is hollow. The wide form (280 px) is the desktop mixer: the level and a meter are always shown. The phone form is a 56 px column with the avatar alone and a badge for what is set; a tap selects the track and the mix lives in the Mix sheet. Drag anywhere on the header except its controls to reorder, or press Shift with Up or Down on the select button; the column owns the drop line. Every callback takes the track's `id` first. A guest hears the mix but cannot change the level or a mix mute, and can still solo and mute for themselves. Under a coarse pointer the default form is one 44 px row, small enough for the shortest lane: the select button, Mute and Solo are 44 px targets, always shown, and the level lives in the Mix sheet. The 280 px form keeps the level in that row. Mute and Solo are 32 px on a desktop.\n\n**Motion.** None. Controls appear without easing.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof TrackHeader>;

const press = async (canvas: ReturnType<typeof within>, name: string) => {
  canvas.getByRole("button", { name: "Maya Okafor" }).focus();
  await userEvent.click(canvas.getByRole("button", { name }));
};

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await press(canvas, "Mute Maya Okafor");
    await press(canvas, "Solo Maya Okafor");
    await press(canvas, "Maya Okafor");
    await expect(args.onMute).toHaveBeenCalledWith("track-maya");
    await expect(args.onSolo).toHaveBeenCalledWith("track-maya");
    await expect(args.onSelect).toHaveBeenCalledWith("track-maya", false);
    await expect(
      canvas.getByRole("spinbutton", { name: "Maya Okafor level" }),
    ).toHaveAttribute("aria-valuetext", "0.0 dB");
  },
};

export const Hover: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole("button", { name: "Maya Okafor" }));
    await expect(
      canvas.getByRole("button", { name: "Mute Maya Okafor" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const Selected: Story = {
  args: { selected: true, level: -3 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Maya Okafor" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const Muted: Story = {
  args: { mute: "saved" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Mute Maya Okafor" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Maya Okafor" }),
    ).toHaveAccessibleDescription("Muted in the mix");
  },
};

export const MutedForYou: Story = {
  args: { mute: "listen" },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Mute Maya Okafor" }),
    ).toHaveAccessibleDescription("Unmute. Muted for you only");
  },
};

export const Soloed: Story = {
  args: { solo: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Solo Maya Okafor" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};

export const ImpliedMute: Story = {
  args: { mute: "implied" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Mute Maya Okafor" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      canvas.getByRole("button", { name: "Maya Okafor" }),
    ).toHaveAccessibleDescription("Silent while another track is soloed");
  },
};

export const Rebuilding: Story = {
  args: { rebuilding: true, playing: 0.4 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Maya Okafor" }),
    ).toHaveAccessibleDescription("Rebuilding");
  },
};

export const Playing: Story = {
  args: { playing: 0.65, level: -3 },
};

export const Wide: Story = {
  args: { form: "wide", playing: 0.55, level: -3, solo: true },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(".sys-track-meter"),
    ).not.toBeNull();
  },
};

export const Phone: Story = {
  args: { form: "phone", mute: "saved" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("spinbutton")).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Maya Okafor" }),
    ).toHaveAccessibleDescription("Muted in the mix");
  },
};

export const Reordering: Story = {
  args: { reorder: "lifted", onDragStart: fn(), onDragEnd: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const name = canvas.getByRole("button", { name: "Maya Okafor" });
    await expect(canvasElement.querySelector(".sys-track")).toHaveAttribute(
      "draggable",
      "true",
    );
    name.focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await expect(args.onMove).toHaveBeenCalledWith("track-maya", 1);
  },
};

export const DropLine: Story = {
  args: { reorder: "before" },
};

export const ReadOnly: Story = {
  args: { readOnly: true, mute: "saved", level: -3 },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await press(canvas, "Mute Maya Okafor");
    await expect(args.onMute).not.toHaveBeenCalled();
    await expect(
      canvas.getByRole("spinbutton", { name: "Maya Okafor level" }),
    ).toHaveAttribute("aria-readonly", "true");
  },
};
