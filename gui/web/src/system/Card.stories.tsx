import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Card } from "./Card";

const meta: Meta<typeof Card> = {
  title: "System/Card",
  component: Card,
  tags: ["autodocs"],
  args: {
    title: "Get ShareCut ready",
    dismissLabel: "Dismiss the setup card",
    onDismiss: fn(),
    children: (
      <p>Speech recognition and noise reduction need a one-time download.</p>
    ),
  },
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
          'A dismissible container for one short message and its actions: the Setup card and the Add to Home Screen hint. The close button is named by the caller, never a bare "Close", and is 44 px. Without `onDismiss` there is no close button.\n\n**Motion.** Dismissing removes the card with `--motion-panel`. Not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Dismiss the setup card" }),
    );
    await expect(args.onDismiss).toHaveBeenCalledOnce();
  },
};
export const Hint: Story = {
  args: {
    tone: "hint",
    title: "Add ShareCut to your Home Screen",
    dismissLabel: "Dismiss: Add to Home Screen hint",
    children: <p>Open it like an app, full screen.</p>,
  },
};
export const NotDismissible: Story = { args: { onDismiss: undefined } };
