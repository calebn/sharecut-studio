import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../../record/recordStoryDecorator";
import {
  enlargedLandscapeSheet,
  inspectorSheetStoryDecorator,
} from "../../test/inspectorSheetDecorator";
import { EnvelopeWorkspaceView } from "./EnvelopeWorkspaceView";

const meta: Meta<typeof EnvelopeWorkspaceView> = {
  title: "Templates/Volume envelope",
  component: EnvelopeWorkspaceView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: "100dvh" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    trackName: "Host",
    points: [],
    pointId: null,
    editable: true,
    form: null,
    busy: false,
    error: null,
    collisionId: null,
    onSelect: fn(),
    onAdd: fn(),
    onEdit: fn(),
    onChange: fn(),
    onSave: fn(),
    onCancel: fn(),
    onDelete: fn(),
    onReload: fn(),
    onDone: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof EnvelopeWorkspaceView>;
export const Empty: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add point" }),
    );
    await expect(args.onAdd).toHaveBeenCalledOnce();
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
export const FirstPoint: Story = {
  args: { form: { kind: "add", pointId: "first", time: "0", level: "1" } },
};
export const Phone: Story = {
  ...FirstPoint,
  globals: recordMobileViewport.globals,
  parameters: recordMobileViewport.parameters,
};
export const CoincidentPoints: Story = {
  args: {
    points: [
      { id: "before", time: 5, value: 1 },
      { id: "after", time: 5, value: 0.5 },
    ],
    pointId: "after",
  },
};
export const Conflict: Story = {
  args: {
    ...FirstPoint.args,
    error: {
      target: "form",
      message:
        "This envelope changed since editing started. Reload points before trying again.",
    },
  },
};
export const Saving: Story = { args: { ...FirstPoint.args, busy: true } };
export const ReadOnly: Story = {
  args: { ...CoincidentPoints.args, editable: false },
};

export const EnlargedTextShortLandscape: Story = {
  ...enlargedLandscapeSheet,
  decorators: [inspectorSheetStoryDecorator],
  args: {
    ...FirstPoint.args,
    trackName: "Host with a deliberately long descriptive track name",
    error: {
      target: "form",
      message:
        "This envelope changed since editing started. Discard the draft and reload points before trying again. Your saved envelope has not changed.",
    },
  },
};
