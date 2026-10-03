import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { TrackFaderView, type TrackFaderViewProps } from "./TrackFaderView";

function ControlledFader(args: TrackFaderViewProps) {
  const [savedDb, setSavedDb] = useState(args.savedDb);
  return (
    <TrackFaderView
      {...args}
      savedDb={savedDb}
      access={
        args.access.kind === "edit"
          ? {
              kind: "edit",
              onCommit: (db) => {
                if (args.access.kind === "edit") args.access.onCommit(db);
                setSavedDb(db);
              },
            }
          : args.access
      }
    />
  );
}
const meta: Meta<typeof TrackFaderView> = {
  title: "Templates/TrackFader",
  component: TrackFaderView,
  tags: ["autodocs"],
  render: (args) => <ControlledFader {...args} />,
  decorators: [
    (Story, context) => (
      <div
        className="daw-shell"
        style={{
          height: "12rem",
          width: context.parameters.faderPhone ? "22.5rem" : "32rem",
          maxWidth: "100%",
        }}
      >
        <main className="track-sheet">
          <Story />
        </main>
      </div>
    ),
  ],
  args: {
    trackLabel: "Mira voice",
    savedDb: -3,
    access: { kind: "edit", onCommit: fn() },
    presentation: {
      kind: "detailed",
      stagingDb: -2,
      balance: { state: "current", measuredLufs: -24.5, ungated: false },
    },
  },
};
export default meta;
type Story = StoryObj<typeof TrackFaderView>;
export const Detailed: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole("slider", { name: "Volume Mira voice" });
    await expect(slider).toHaveValue("-3");
    await expect(
      canvas.getByText("Staging gain −2.0 dB; plays at −5.0 dB"),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Reset volume to 0 dB" }),
    );
    await expect(slider).toHaveValue("0");
    await expect(slider).toHaveFocus();
    await expect(
      canvas.getByRole("button", { name: "Reset volume to 0 dB" }),
    ).toBeDisabled();
    if (args.access.kind === "edit")
      await expect(args.access.onCommit).toHaveBeenCalledWith(0);
  },
};
export const ReadOnly: Story = {
  args: { access: { kind: "read-only" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("slider", { name: "Volume Mira voice" }),
    ).toBeDisabled();
    await expect(canvas.getByRole("slider")).toHaveAccessibleDescription(
      /^Only the host and editors can change the volume\./,
    );
    await expect(canvas.getByRole("status")).toHaveTextContent("−3.0 dB");
  },
};
export const StaleBalance: Story = {
  args: {
    presentation: {
      kind: "detailed",
      stagingDb: -2,
      balance: { state: "stale", measuredLufs: -24.5, ungated: true },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Balance stale · -24.5 LUFS · ungated"),
    ).toBeVisible();
  },
};
export const NonDialogue: Story = {
  args: { presentation: { kind: "detailed", stagingDb: 0, balance: null } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Staging gain 0.0 dB; plays at −3.0 dB"),
    ).toBeVisible();
  },
};
export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, faderPhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("slider", { name: "Volume Mira voice" }),
    ).toHaveValue("-3");
  },
};
