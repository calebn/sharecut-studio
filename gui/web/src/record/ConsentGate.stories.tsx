import type { Meta, StoryObj } from "@storybook/react-vite";
import { ConsentGate } from "./ConsentGate";

const noop = () => undefined;

const meta: Meta<typeof ConsentGate> = {
  title: "Record/ConsentGate",
  component: ConsentGate,
  tags: ["autodocs"],
  args: {
    onAccept: noop,
    onDecline: noop,
  },
};

export default meta;
type Story = StoryObj<typeof ConsentGate>;

export const Default: Story = {};

export const CannotAccept: Story = {
  args: {
    canAccept: false,
    acceptDescribedBy: "consent-blocker",
  },
  render: (args) => (
    <>
      <p id="consent-blocker">Finish device check before accepting.</p>
      <ConsentGate {...args} />
    </>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Accept stays disabled until the blocker clears; the reason is exposed through aria-describedby.",
      },
    },
  },
};
