import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  type BleedAttenuationInspection,
  bleedAttenuationRegionKey,
} from "../../edit/bleedAttenuation";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { BleedAttenuationInspector } from "./BleedAttenuationInspector";

const inspection: BleedAttenuationInspection<{ seal: string }> = {
  clipLabel: "Synthetic fixture · Mira clip, 5 to 8 seconds",
  planState: "ready",
  planReasons: [],
  artifactState: "stale",
  restoreState: "current",
  savedSourceSpans: [{ start: 20, end: 20.5 }],
  regions: [
    {
      trackId: "mira",
      occurrenceId: "clip-one",
      kind: "late_gate",
      sourceSpan: { start: 20, end: 21 },
      timelineSpan: { start: 5, end: 6 },
      restore: {
        state: "available",
        target: { seal: "synthetic-late-target" },
        sourceSpan: { start: 20.5, end: 21 },
      },
    },
    {
      trackId: "mira",
      occurrenceId: "clip-one",
      kind: "bleed_mute:off_speaker",
      sourceSpan: { start: 22, end: 23 },
      timelineSpan: { start: 7, end: 8 },
      restore: {
        state: "available",
        target: { seal: "synthetic-mask-target" },
        sourceSpan: { start: 22, end: 23 },
      },
    },
  ],
};
const Inspector = BleedAttenuationInspector<{ seal: string }, { head: string }>;
const meta: Meta<typeof Inspector> = {
  title: "Templates/BleedAttenuationInspector",
  component: Inspector,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <main
        className="bleed-inspector-preview"
        aria-label="Synthetic automatic reduction inspector"
      >
        <Story />
      </main>
    ),
  ],
  parameters: { ...isolatedStoryParameters, layout: "fullscreen" },
  args: {
    read: { state: "ready", inspection },
    selectedKey: bleedAttenuationRegionKey(inspection.regions[0]),
    onSelect: fn(),
    access: "host",
    canRestore: true,
    action: { state: "idle" },
    onRestore: fn(),
    onRefresh: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof Inspector>;
export const PartialSavedChoice: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/Saved choices are pending in the next render/),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Restore original audio" }),
    );
    await expect(args.onRestore).toHaveBeenCalledWith({
      seal: "synthetic-late-target",
    });
  },
};
export const StaleTarget: Story = {
  args: {
    action: {
      state: "error",
      code: "STALE_TARGET",
      message: "This clip changed. Nothing was saved.",
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Restore original audio" }),
    ).toBeDisabled();
    await userEvent.click(
      canvas.getByRole("button", { name: "Refresh regions" }),
    );
    await expect(args.onRefresh).toHaveBeenCalledOnce();
  },
};
export const SavedWithUndo: Story = {
  args: {
    read: {
      state: "ready",
      inspection: {
        ...inspection,
        artifactState: "current",
        regions: [{ ...inspection.regions[0], restore: { state: "saved" } }],
      },
    },
    undo: { receipt: { head: "synthetic-history-head" }, onUndo: fn() },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Undo Restore" }),
    );
    await expect(args.undo?.onUndo).toHaveBeenCalledWith({
      head: "synthetic-history-head",
    });
  },
};
export const DisabledLatePlan: Story = {
  args: {
    read: {
      state: "ready",
      inspection: { ...inspection, planState: "disabled" },
    },
    selectedKey: bleedAttenuationRegionKey(inspection.regions[1]),
  },
};
export const UnavailableEvidence: Story = {
  args: {
    read: {
      state: "ready",
      inspection: {
        ...inspection,
        planState: "unavailable_evidence",
        planReasons: [
          "The recording could not be checked. Check the recording and refresh regions.",
        ],
      },
    },
  },
};
export const ChangedRecording: Story = {
  args: {
    read: {
      state: "ready",
      inspection: { ...inspection, restoreState: "changed_content" },
    },
  },
};
export const Loading: Story = { args: { read: { state: "loading" } } };
export const Empty: Story = {
  args: {
    read: {
      state: "ready",
      inspection: {
        ...inspection,
        regions: [],
        artifactState: "missing",
        restoreState: "none",
        savedSourceSpans: [],
      },
    },
  },
};
export const FailedLoad: Story = {
  args: {
    read: {
      state: "error",
      message: "Could not check this recording. Try refreshing regions.",
    },
  },
};
export const Saving: Story = {
  args: { action: { state: "saving", elapsedSeconds: 3 } },
};
export const Guest: Story = { args: { access: "guest" } };
export const Permission: Story = {
  args: {
    canRestore: false,
    permissionReason: "Open this project as its host to restore audio.",
  },
};
