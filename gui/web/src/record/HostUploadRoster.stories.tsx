import type { Meta, StoryObj } from "@storybook/react-vite";
import { recordParticipant } from "../test/fixtures";
import { HostUploadRoster } from "./HostUploadRoster";

// Factories, not shared constants: each story gets fresh objects so a future
// `play` function cannot leak mutations into sibling stories.
const host = () =>
  recordParticipant({
    participant_id: "host-1",
    role: "host",
    display_name: "Ada",
  });

const guest = () =>
  recordParticipant({ participant_id: "guest-1", display_name: "Bo" });

const producer = () =>
  recordParticipant({
    participant_id: "prod-1",
    role: "producer",
    display_name: "Cy",
    muted: true,
  });

const meta: Meta<typeof HostUploadRoster> = {
  title: "Templates/HostUploadRoster",
  component: HostUploadRoster,
  tags: ["autodocs"],
  // The app renders the roster inside the host Record room dialog body.
  decorators: [
    (Story) => (
      <div className="stack record-panel">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof HostUploadRoster>;

export const Uploading: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      { participant_id: "host-1", acked_parts: [0, 1, 2], file_ack: false },
      { participant_id: "guest-1", acked_parts: [0, 1], file_ack: false },
    ],
    stopped: false,
  },
};

export const ExpectedParts: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      {
        participant_id: "host-1",
        acked_parts: [0, 1, 2],
        expected_parts: 5,
        file_ack: false,
      },
      {
        participant_id: "guest-1",
        acked_parts: [0],
        expected_parts: 4,
        file_ack: false,
      },
    ],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Segments declare their chunk total, so each line shows acked / expected progress.",
      },
    },
  },
};

export const UploadedAwaitingLand: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      { participant_id: "host-1", acked_parts: [0, 1, 2], file_ack: true },
      { participant_id: "guest-1", acked_parts: [0, 1], file_ack: true },
    ],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Every file is acknowledged but the host has not landed it into the project yet.",
      },
    },
  },
};

export const Landed: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      {
        participant_id: "host-1",
        acked_parts: [0, 1, 2],
        file_ack: true,
        landed: true,
      },
      {
        participant_id: "guest-1",
        acked_parts: [0, 1],
        file_ack: true,
        landed: true,
      },
    ],
    stopped: true,
  },
};

export const LandFailed: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      {
        participant_id: "host-1",
        acked_parts: [0, 1, 2],
        file_ack: true,
        landed: true,
      },
      {
        participant_id: "guest-1",
        acked_parts: [0, 1],
        file_ack: true,
        land_failed: true,
      },
    ],
    stopped: true,
  },
};

export const MultipleSegments: Story = {
  args: {
    participants: [host(), guest()],
    segments: [
      {
        participant_id: "host-1",
        acked_parts: [0, 1],
        file_ack: true,
        landed: true,
      },
      {
        participant_id: "host-1",
        acked_parts: [0],
        file_ack: true,
        landed: true,
      },
      {
        participant_id: "guest-1",
        acked_parts: [0, 1],
        file_ack: true,
        landed: true,
      },
      { participant_id: "guest-1", acked_parts: [0], file_ack: false },
    ],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Segments fold per participant: a line reads uploaded or landed only when every segment does, while acked chunks sum across segments. Ada's two landed segments read landed; Bo still has one segment in flight.",
      },
    },
  },
};

export const UnknownParticipant: Story = {
  args: {
    participants: [host()],
    segments: [
      { participant_id: "host-1", acked_parts: [0], file_ack: true },
      { participant_id: "p_left_early", acked_parts: [0, 1], file_ack: true },
    ],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "A segment whose participant is not in the roster falls back to the raw participant id.",
      },
    },
  },
};

export const ProducerExcluded: Story = {
  args: {
    participants: [host(), producer()],
    segments: [{ participant_id: "host-1", acked_parts: [0], file_ack: true }],
    stopped: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "Producers never record, so Cy (a producer with no segments) is filtered out of the roster.",
      },
    },
  },
};

const longNames = [
  "Maximiliana Wolfeschlegelsteinhausen-Bergerdorff",
  "Oluwaseun Adebayo-Okonkwo-Fitzgerald",
  "Guest With An Unreasonably Long Display Name From The Lobby",
  "Siobhán Ní Mhaolchatha-Venkataraman",
];

export const StressLongNamesMobile: Story = {
  args: {
    participants: [
      ...longNames.map((display_name, index) =>
        recordParticipant({
          participant_id: `p_${index}`,
          role: index === 0 ? "host" : "guest",
          display_name,
        }),
      ),
      recordParticipant({
        participant_id: "p_removed",
        display_name: "Departed Guest From An Earlier Take",
        connected: false,
        removed: true,
      }),
      producer(),
    ],
    segments: [
      {
        participant_id: "p_0",
        acked_parts: [0, 1, 2, 3],
        expected_parts: 12,
        file_ack: false,
      },
      {
        participant_id: "p_1",
        acked_parts: [0, 1],
        file_ack: true,
        landed: true,
      },
      {
        participant_id: "p_2",
        acked_parts: [0, 1],
        file_ack: true,
        land_failed: true,
      },
      { participant_id: "p_3", acked_parts: [0, 1], file_ack: true },
      {
        participant_id: "p_removed",
        acked_parts: [0, 1, 2],
        file_ack: true,
        landed: true,
      },
      { participant_id: "p_orphan_segment_id", acked_parts: [0, 1] },
    ],
    stopped: true,
  },
  parameters: {
    viewport: {
      options: {
        phone360: {
          name: "Phone 360",
          styles: { width: "360px", height: "640px" },
          type: "mobile",
        },
      },
    },
    docs: {
      description: {
        story:
          "Stress fixture at a 360px viewport. The room caps recorded participants at four, so this fills the cap with long names, then adds an earlier-take guest and an orphan segment id.",
      },
    },
  },
  globals: { viewport: { value: "phone360", isRotated: false } },
};
