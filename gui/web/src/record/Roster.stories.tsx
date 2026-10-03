import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { isolatedStoryParameters } from "../storybook/storyLayout";
import { recordParticipant } from "../test/fixtures";
import { Roster } from "./Roster";
import {
  recordMobileViewport,
  recordStoryDecorator,
} from "./recordStoryDecorator";

const meta: Meta<typeof Roster> = {
  title: "Templates/Roster",
  component: Roster,
  tags: ["autodocs"],
  parameters: isolatedStoryParameters,
  decorators: [recordStoryDecorator],
  args: {
    participants: [
      recordParticipant({
        participant_id: "p_host",
        role: "host",
        display_name: "Ada",
      }),
      recordParticipant({ display_name: "Bo", muted: true }),
      recordParticipant({
        participant_id: "producer-1",
        role: "producer",
        display_name: "Cy",
        consented: null,
      }),
    ],
  },
};
export default meta;
type Story = StoryObj<typeof Roster>;
export const MixedRoles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Recording" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Not recorded" }),
    ).toBeVisible();
    await expect(canvas.getByText("Bo · consented · muted")).toBeVisible();
  },
};
export const Empty: Story = { args: { participants: [] } };
export const DisconnectedAndRemoved: Story = {
  args: {
    participants: [
      recordParticipant({
        display_name: "Disconnected guest",
        connected: false,
      }),
      recordParticipant({
        participant_id: "removed-1",
        display_name: "Removed guest",
        removed: true,
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Disconnected guest")).toBeNull();
    await expect(canvas.queryByText("Removed guest")).toBeNull();
  },
};
export const ConsentPendingAndDeclined: Story = {
  args: {
    participants: [
      recordParticipant({ display_name: "Bo", consented: null }),
      recordParticipant({
        participant_id: "guest-2",
        display_name: "Dee",
        consented: false,
      }),
    ],
  },
};
export const LongNamesPhone: Story = {
  globals: recordMobileViewport.globals,
  parameters: recordMobileViewport.parameters,
  args: {
    participants: [
      recordParticipant({
        display_name: "AlexandriaWithAnExceptionallyLongUnbrokenDisplayName",
        muted: true,
      }),
      recordParticipant({
        participant_id: "producer-1",
        role: "producer",
        display_name: "Cy the guest producer with a long display name",
        consented: null,
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    for (const roster of canvasElement.querySelectorAll(".record-roster")) {
      await expect(roster.scrollWidth).toBeLessThanOrEqual(roster.clientWidth);
    }
  },
};
