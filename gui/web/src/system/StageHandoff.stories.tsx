import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { StageHandoff } from "./StageHandoff";

const meta: Meta<typeof StageHandoff> = {
  title: "System/StageHandoff",
  component: StageHandoff,
  tags: ["autodocs"],
  args: {
    stage: "review",
    label: "Review 14 suggestions",
    onActivate: fn(),
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
          "The button that hands the work to the next stage: the stage icon, the label, an arrow. Secondary until the work is done, then primary once per group. Sizes 36, 40 and 48 (full width on a phone, with no key hint). A disabled hand-off stays focusable and shows why beside it. The key hint is display only (Cmd+Enter on Apple platforms, Ctrl+Enter elsewhere): no key is bound in this slice.\n\n**Motion.** Hover and press change the fill with `--motion-hover`. Nothing else moves.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof StageHandoff>;

export const Rest: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Review 14 suggestions",
      }),
    );
    await expect(args.onActivate).toHaveBeenCalledOnce();
  },
};

export const Primary: Story = {
  args: { variant: "primary", stage: "edit", label: "Edit Session 2" },
};

export const Inline36: Story = { args: { size: 36 } };

export const Disabled: Story = {
  args: { disabledReason: "Name every voice first." },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", {
      name: "Review 14 suggestions",
    });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAccessibleDescription("Name every voice first.");
    await expect(canvas.getByText("Name every voice first.")).toBeVisible();
    await userEvent.click(button);
    await expect(args.onActivate).not.toHaveBeenCalled();
  },
};

export const Focused: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.tab();
    await expect(
      within(canvasElement).getByRole("button", {
        name: "Review 14 suggestions",
      }),
    ).toHaveFocus();
  },
};

export const Phone: Story = {
  args: {
    size: 48,
    variant: "primary",
    stage: "edit",
    label: "Edit Session 2",
  },
  globals: { viewport: { value: "mobile360", isRotated: false } },
};
