import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { registryModels, withModels } from "../../test/modelsStory";
import { BounceSection } from "./BounceSection";
import { BOUNCE_DEFAULTS, type BounceChoices } from "./bounceLogic";

type Args = React.ComponentProps<typeof BounceSection>;

function Controlled(args: Args) {
  const [choices, setChoices] = useState<BounceChoices>(args.options.choices);
  return (
    <BounceSection
      {...args}
      options={{ ...args.options, choices, onChoices: setChoices }}
    />
  );
}

const meta: Meta<typeof BounceSection> = {
  title: "Stages/Deliver/Bounce",
  component: BounceSection,
  tags: ["autodocs"],
  render: (args) => <Controlled {...args} />,
  args: {
    options: {
      state: { phase: "idle" },
      choices: BOUNCE_DEFAULTS,
      onChoices: fn(),
      selectedCount: 2,
      soloCount: 0,
      hasRegion: true,
      onBounce: fn(),
      onCancel: fn(),
    },
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)", maxInlineSize: "40rem" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A quick mix written to export/bounces/ without mastering: the whole mix, the selected or soloed tracks, or a range fixed in Edit; optionally limited to the session region, with an MP3 beside the WAV. It runs outside the page, so leaving Deliver keeps it going.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof BounceSection>;

export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole("button", { name: "Entire mix" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(
      view.getByRole("button", { name: "Selected tracks (2)" }),
    );
    await expect(
      view.getByRole("button", { name: "Selected tracks (2)" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(view.getByRole("button", { name: "Also write MP3" }));
    await userEvent.click(view.getByRole("button", { name: "Bounce" }));
    await expect(args.options.onBounce).toHaveBeenCalledOnce();
  },
};

export const NoTracksSelected: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      choices: { ...BOUNCE_DEFAULTS, source: "selected" },
      selectedCount: 0,
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("button", { name: "Bounce" })).toBeDisabled();
    await expect(
      view.getByText("Select one or more tracks first."),
    ).toBeVisible();
  },
};

export const NoTracksSoloed: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      choices: { ...BOUNCE_DEFAULTS, source: "soloed" },
      soloCount: 0,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText("Solo one or more tracks first."),
    ).toBeVisible();
  },
};

export const NoRegion: Story = {
  args: { options: { ...meta.args!.options!, hasRegion: false } },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Limit to session region",
      }),
    ).toBeDisabled();
  },
};

export const FixedRange: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      fixedRange: "12.00–18.50 s on host, guest",
      onClearRange: fn(),
    },
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(
      view.getByText(
        "Selected range · 12.00–18.50 s on host, guest. This selection is fixed for this bounce.",
      ),
    ).toBeVisible();
    await expect(view.queryByRole("group", { name: "Source" })).toBeNull();
    await userEvent.click(
      view.getByRole("button", { name: "Bounce the whole mix instead" }),
    );
    await expect(args.options.onClearRange).toHaveBeenCalledOnce();
  },
};

export const FixedRangeRunning: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      fixedRange: "12.00–18.50 s on host, guest",
      rangeIsRunning: true,
      onClearRange: fn(),
      state: { phase: "running", progress: 0.4, detail: "Mixing" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Selected range · 12.00–18.50 s on host, guest. This selection is fixed for this bounce.",
      ),
    ).toBeVisible();
  },
};

export const FixedRangeWhileRunning: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      fixedRange: "12.00–18.50 s on host, guest",
      onClearRange: fn(),
      state: { phase: "running", progress: 0.4, detail: "Mixing" },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Selected range · 12.00–18.50 s on host, guest. This selection is fixed for the next bounce.",
      ),
    ).toBeVisible();
  },
};

export const Starting: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "running",
        progress: null,
        detail: "Starting bounce…",
        cancelReason:
          "The bounce is still starting. Cancel once it has started.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(view.getByRole("button", { name: "Bounce" })).toBeDisabled();
  },
};

export const Running: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "running",
        progress: 0.4,
        detail: "Mixing · 1 of 3 · Elapsed 0:08",
      },
      onCancel: fn(),
    },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Cancel" }),
    );
    await expect(args.options.onCancel).toHaveBeenCalledOnce();
  },
};

export const CancelFailed: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "running",
        progress: 0.4,
        detail: "Mixing · 40%",
        cancelError: "The server did not answer.",
      },
    },
  },
};

export const Done: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "done",
        summary: "Bounced 2 file(s) to export/bounces/",
        files: ["mix.wav", "mix.mp3"],
      },
    },
  },
};

export const Failed: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: { phase: "failed", cause: "The disk is full." },
      onAgain: fn(),
    },
  },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Try again" }),
    );
    await expect(args.options.onAgain).toHaveBeenCalledOnce();
  },
};

export const Cancelled: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "cancelled",
        detail: "Bounce cancelled. Files from an earlier bounce are unchanged.",
        files: [],
      },
      onAgain: fn(),
    },
  },
};

export const NeedsModel: Story = {
  args: {
    options: {
      ...meta.args!.options!,
      state: {
        phase: "needs-model",
        model: {
          id: "speaker-ecapa",
          variant: null,
          label: "Speaker model",
          purpose: "speaker recognition and split",
          size: "~25 MB",
          sizeBytes: null,
          state: "missing",
        },
      },
    },
  },
  decorators: [withModels],
  parameters: {
    models: {
      models: registryModels({ "speaker-ecapa": { kind: "missing" } }),
    },
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole("button", { name: "Bounce" })).toBeNull();
    await expect(view.queryByRole("group", { name: "Source" })).toBeNull();
    await expect(
      view.getByRole("button", { name: "Get the speaker model" }),
    ).toBeEnabled();
  },
};

export const Loading: Story = { args: { state: "loading" } };

export const Phone: Story = {
  decorators: [
    (Story) => (
      <div style={{ inlineSize: "22.5rem", maxInlineSize: "100%" }}>
        <Story />
      </div>
    ),
  ],
};
