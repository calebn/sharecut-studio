import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { StartTile } from "./StartTile";

const meta: Meta<typeof StartTile> = {
  title: "System/StartTile",
  component: StartTile,
  tags: ["autodocs"],
  args: { kind: "import", size: 160, onActivate: fn() },
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
          "A large tap-and-drop target that starts an episode. Import audio shows the Import key (Mod+I) and Record shows R. Sizes 220 (empty Home), 160 (Home), 80 (Prepare Sources footer) and the 72 px phone bar. A disabled tile stays focusable and says why in place of its line.\n\n**Motion.** Hover and drag-hover change the border and fill with `--motion-hover`. Not implemented in this slice.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StartTile>;

export const ImportRest: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Import audio" }));
    await expect(args.onActivate).toHaveBeenCalledOnce();
  },
};
export const RecordRest: Story = { args: { kind: "record" } };
export const Large220: Story = { args: { size: 220 } };
export const Compact80: Story = { args: { size: 80 } };
export const DragHover: Story = { args: { state: "drag-hover" } };
export const Disabled: Story = {
  args: {
    kind: "record",
    state: "disabled",
    disabledReason: "Finish the current save first.",
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const tile = canvas.getByRole("button", { name: "Record" });
    await expect(tile).toHaveAttribute("aria-disabled", "true");
    await expect(tile).toHaveAccessibleDescription(
      "Finish the current save first.",
    );
    await userEvent.click(tile);
    await expect(args.onActivate).not.toHaveBeenCalled();
  },
};

export const PhoneBar: Story = {
  args: { size: "phone-bar" },
  render: (args) => (
    <div className="sys-start-pair">
      <StartTile {...args} kind="import" />
      <StartTile {...args} kind="record" />
    </div>
  ),
};
