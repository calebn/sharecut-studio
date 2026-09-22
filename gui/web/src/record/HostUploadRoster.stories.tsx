import type { Meta, StoryObj } from "@storybook/react-vite";
import { HostUploadRoster } from "./HostUploadRoster";
import type { RecordParticipant } from "./types";

const host: RecordParticipant = {
  participant_id: "host-1",
  role: "host",
  display_name: "Ada",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const guest: RecordParticipant = {
  participant_id: "guest-1",
  role: "guest",
  display_name: "Bo",
  connected: true,
  consented: true,
  muted: false,
  headphones_ack: true,
};

const producer: RecordParticipant = {
  participant_id: "prod-1",
  role: "producer",
  display_name: "Cy",
  connected: true,
  consented: true,
  muted: true,
  headphones_ack: true,
};

const meta: Meta<typeof HostUploadRoster> = {
  title: "Record/HostUploadRoster",
  component: HostUploadRoster,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof HostUploadRoster>;

export const Uploading: Story = {
  args: {
    participants: [host, guest],
    segments: [
      { participant_id: "host-1", acked_parts: [0, 1, 2], file_ack: false },
      { participant_id: "guest-1", acked_parts: [0], file_ack: false },
    ],
    stopped: false,
  },
};

export const Complete: Story = {
  args: {
    participants: [host, guest],
    segments: [
      { participant_id: "host-1", acked_parts: [0, 1, 2], file_ack: true },
      { participant_id: "guest-1", acked_parts: [0, 1], file_ack: true },
    ],
    stopped: true,
  },
};

export const ProducerExcluded: Story = {
  args: {
    participants: [host, producer],
    segments: [{ participant_id: "host-1", acked_parts: [0], file_ack: true }],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story: "Producers never record, so Cy is filtered out of the roster.",
      },
    },
  },
};

export const RendersNothingWhileWaiting: Story = {
  args: { participants: [host, guest], segments: [], stopped: false },
  parameters: {
    docs: {
      description: {
        story:
          "By design this renders nothing: with no segments yet, every line would read “waiting to upload.”",
      },
    },
  },
};
