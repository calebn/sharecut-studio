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
    presentation: { kind: "compact" },
  },
};
export default meta;
type Story = StoryObj<typeof TrackFaderView>;
export const Compact: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("spinbutton", { name: "Volume Mira voice" });
    await expect(field).toHaveAttribute("aria-valuenow", "-3");
    field.focus();
    await userEvent.keyboard("{ArrowUp}");
    if (args.access.kind === "edit")
      await expect(args.access.onCommit).toHaveBeenCalled();
  },
};
export const ReadOnly: Story = {
  args: { access: { kind: "read-only" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("spinbutton", { name: "Volume Mira voice" }),
    ).toHaveAttribute("aria-readonly", "true");
  },
};
export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, faderPhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("spinbutton", {
        name: "Volume Mira voice",
      }),
    ).toHaveAttribute("aria-valuenow", "-3");
  },
};
