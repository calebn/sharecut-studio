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
        className="stage-frame stage-frame--desktop"
        style={{
          height: "12rem",
          gridTemplateRows: "minmax(0, 1fr)",
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
    presentation: { kind: "compact", descriptionId: "fader-story-note" },
  },
};
export default meta;
type Story = StoryObj<typeof TrackFaderView>;
export const Compact: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole("slider", { name: "Volume Mira voice" });
    await expect(slider).toHaveValue("-3");
    await userEvent.dblClick(slider);
    await expect(slider).toHaveValue("0");
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
    await expect(canvas.getByRole("status")).toHaveTextContent("−3.0 dB");
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
