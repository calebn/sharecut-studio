import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { AbAudition } from "./AbAudition";
import { ActionBarInline, ActionPrompt } from "./ActionBarInline";

const meta: Meta<typeof ActionBarInline> = {
  title: "System/ActionBarInline",
  component: ActionBarInline,
  tags: ["autodocs"],
  args: {
    verb: "cut",
    onKeep: fn(),
    onVerb: fn(),
    onLater: fn(),
    onOpenInEdit: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "var(--space-5)" }}>
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
          "The Action bar inside a Decision card. Keep, the no, sits left of the primary, the yes, which is the one accent fill. Later moves on without deciding and Open in Edit sits at the far leading edge. Verbs that do not apply are absent. The dock form is the phone's one 64 px row: Keep, A/B, verb. `ActionPrompt` is the inline form shown while the transcript gate is open: Cut anyway, Check words, Add a note.\n\n**Motion.** Animations come later: the prompt opens in place with `--motion-panel`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ActionBarInline>;

export const Suggestion: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Keep" }));
    await userEvent.click(canvas.getByRole("button", { name: "Cut" }));
    await userEvent.click(canvas.getByRole("button", { name: "Later" }));
    await userEvent.click(canvas.getByRole("button", { name: "Open in Edit" }));
    await expect(args.onKeep).toHaveBeenCalledOnce();
    await expect(args.onVerb).toHaveBeenCalledOnce();
    await expect(args.onLater).toHaveBeenCalledOnce();
    await expect(args.onOpenInEdit).toHaveBeenCalledOnce();
  },
};

export const Pause: Story = { args: { verb: "shorten" } };

export const Comment: Story = { args: { verb: "resolve" } };

export const LooksRight: Story = {
  args: { verb: "approve", verbLabel: "Looks right" },
};

export const VerbWaiting: Story = {
  args: { verbDisabledReason: "Check the unsure word first." },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Cut" }),
    ).toBeDisabled();
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Keep" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Open in Edit" }),
    ).toBeVisible();
  },
};

export const Dock: Story = {
  args: {
    form: "dock",
    center: (
      <AbAudition
        side="B"
        change={{ start: 1114, end: 1115 }}
        onSelect={() => undefined}
      />
    ),
  },
};

export const Phone: Story = { ...Dock };

export const PromptHolding: Story = {
  args: { promptOpen: true },
  render: (args) => (
    <>
      <ActionPrompt
        verb="cut"
        checkLabel="Check 3 words"
        onConfirm={fn()}
        onCheck={fn()}
      />
      <ActionBarInline {...args} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getAllByRole("button", { name: "Cut anyway" }),
    ).toHaveLength(1);
    await expect(canvas.queryByRole("button", { name: "Cut" })).toBeNull();
  },
};

export const CutAnyway: StoryObj<typeof ActionPrompt> = {
  render: (args) => <ActionPrompt {...args} />,
  args: {
    verb: "cut",
    checkLabel: "Check 3 words",
    onConfirm: fn(),
    onCheck: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Check 3 words" }),
    );
    await expect(args.onCheck).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Cut anyway" }));
    await expect(args.onConfirm).toHaveBeenLastCalledWith(undefined);
  },
};

export const AddANote: StoryObj<typeof ActionPrompt> = {
  ...CutAnyway,
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add a note" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Your reason" }),
      "Heard it{Enter}",
    );
    await expect(args.onConfirm).toHaveBeenLastCalledWith("Heard it");
  },
};
