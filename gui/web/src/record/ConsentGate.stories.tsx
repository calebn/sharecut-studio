import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { ConsentGate } from "./ConsentGate";
import { MIC_GRANT_HINT_COPY } from "./micPermission";
import { ROOM_TONE_GATE_COPY } from "./types";

// Blocker notes use the locked copy Lobby.tsx points aria-describedby at.
// Ids are unique per story so the autodocs page has no duplicate ids.
const BLOCKER_COPY: Record<string, string> = {
  "consent-blocker-room-tone": ROOM_TONE_GATE_COPY,
  "consent-blockers-mic": MIC_GRANT_HINT_COPY,
  "consent-blockers-room-tone": ROOM_TONE_GATE_COPY,
};

const meta: Meta<typeof ConsentGate> = {
  title: "Templates/ConsentGate",
  component: ConsentGate,
  tags: ["autodocs"],
  args: {
    onAccept: fn(),
    onDecline: fn(),
  },
  // Production renders inside RecordApp's record shell; its type scale and
  // heading styles only apply under these classes.
  decorators: [
    (Story) => (
      <div className="review-shell record-shell">
        <Story />
      </div>
    ),
  ],
  render: (args) => (
    <>
      {args.canAccept === false
        ? (args.acceptDescribedBy ?? "")
            .split(" ")
            .filter((id) => id in BLOCKER_COPY)
            .map((id) => (
              <p key={id} id={id}>
                {BLOCKER_COPY[id]}
              </p>
            ))
        : null}
      <ConsentGate {...args} />
    </>
  ),
};

export default meta;
type Story = StoryObj<typeof ConsentGate>;

const expectBlocked: Story["play"] = async ({ canvasElement, args }) => {
  const accept = within(canvasElement).getByRole("button", { name: "Accept" });
  const ids = (args.acceptDescribedBy ?? "").split(" ");
  await expect(accept).toBeDisabled();
  await expect(accept).toHaveAttribute("aria-describedby", ids.join(" "));
  for (const id of ids) {
    await expect(canvasElement.querySelector(`[id="${id}"]`)).toHaveTextContent(
      BLOCKER_COPY[id],
    );
  }
};

export const Default: Story = {};

export const CannotAccept: Story = {
  args: {
    canAccept: false,
    acceptDescribedBy: "consent-blocker-room-tone",
  },
  play: expectBlocked,
  parameters: {
    docs: {
      description: {
        story:
          "Accept stays disabled until the blocker clears; the reason is exposed through aria-describedby.",
      },
    },
  },
};

export const MultipleBlockers: Story = {
  args: {
    canAccept: false,
    acceptDescribedBy: "consent-blockers-mic consent-blockers-room-tone",
  },
  play: expectBlocked,
  parameters: {
    docs: {
      description: {
        story:
          "Lobby joins every open blocker into one space-separated aria-describedby; each id resolves to its note.",
      },
    },
  },
};
