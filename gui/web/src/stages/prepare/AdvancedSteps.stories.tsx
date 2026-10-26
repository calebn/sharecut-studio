import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  expect,
  fireEvent,
  fn,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { AdvancedSteps, type AdvancedStepsProps } from "./AdvancedSteps";
import { GROUPS, RUNNING } from "./advancedFixture";
import { useAdvancedDemo } from "./useAdvancedDemo";

const meta: Meta<typeof AdvancedSteps> = {
  title: "Stages/Prepare/AdvancedSteps",
  component: AdvancedSteps,
  tags: ["autodocs"],
  args: {
    groups: GROUPS,
    onSelect: fn(),
    onBack: fn(),
    onToggle: fn(),
    onParam: fn(),
    onReset: fn(),
    onRunFromHere: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          padding: "var(--space-5)",
          maxInlineSize: "25rem",
          background: "var(--color-bg-canvas)",
        }}
      >
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
          'The full step list behind Advanced, and one step\'s settings in the same panel at every width. Steps are grouped like the Getting ready rows and carry a plain name, their last result and, for optional steps, a switch named by the step. Only the steps the design maps are listed; the rest of the pipeline is left out. Choosing a step moves focus to its heading, and "Back to steps" (a visible button) returns focus to the row that opened it. Settings commit on change with no Apply. A scrub field is a native slider, so the arrow keys, Home, End, Page Up and Page Down work and it is read in plain units ("5 seconds"); language is a native select with "Detect automatically" first. A reset dot appears when a setting is not its default and is a real button, "Reset to default: <setting>". Help is a line that shows while a field has focus and is always read with it. While a step runs, a Status row with Cancel shows on top and the switches are disabled, with the reason written under it.\n\n**Motion.** The row arrow and the switch knob move with `--motion-hover`; the progress bar grows with `--motion-state`. Not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof AdvancedSteps>;

function Live({
  selected,
  ...props
}: AdvancedStepsProps & { selected?: string }) {
  const demo = useAdvancedDemo(
    props.groups,
    selected ?? props.selectedId,
    props,
  );
  return <AdvancedSteps {...props} {...demo} />;
}

const live =
  (selected?: string): Story["render"] =>
  (args) => <Live {...args} selected={selected} />;
const phone = { viewport: { value: "mobile360", isRotated: false } };

export const List: Story = {
  render: live(),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Advanced steps" }),
    ).toBeVisible();
    const gaps = canvas.getByRole("switch", {
      name: "Fill gaps from the recorder's noise gate",
    });
    await expect(gaps).toBeChecked();
    await userEvent.click(gaps);
    await expect(args.onToggle).toHaveBeenCalledWith("fill-gaps", false);
    await expect(gaps).not.toBeChecked();
  },
};

export const StepSelected: Story = {
  render: live("align"),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole("slider", { name: "Largest move" });
    await expect(slider).toHaveAttribute("aria-valuetext", "5 seconds");
    // A native range takes the arrow keys in the browser; jsdom does not, so
    // the change a key makes is sent here.
    await fireEvent.change(slider, { target: { value: "7" } });
    await expect(slider).toHaveAttribute("aria-valuetext", "7 seconds");
    await expect(args.onParam).toHaveBeenLastCalledWith("align", "max-move", 7);
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Reset to default: Largest move",
      }),
    );
    await expect(slider).toHaveAttribute("aria-valuetext", "5 seconds");
    await userEvent.click(
      canvas.getByRole("button", { name: "Back to steps" }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /^Line up tracks/ }),
      ).toHaveFocus(),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: /^Line up tracks/ }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { level: 2, name: "Line up tracks" }),
      ).toHaveFocus(),
    );
  },
};

export const StepRunning: Story = {
  args: { running: RUNNING },
  render: live(),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("progressbar", { name: "Line up tracks" }),
    ).toBeVisible();
    const gaps = canvas.getByRole("switch", {
      name: "Fill gaps from the recorder's noise gate",
    });
    await expect(gaps).toBeDisabled();
    await expect(gaps).toHaveAccessibleDescription(
      "Steps cannot change while one is running.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(args.onCancel).toHaveBeenCalled();
  },
};

export const Phone: Story = {
  render: live(),
  globals: phone,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("switch")).toHaveLength(2);
  },
};

export const PhoneStep: Story = {
  render: live("transcribe"),
  globals: phone,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("combobox", { name: "Language" }),
    ).toHaveDisplayValue("Detect automatically");
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Language" }),
      "es",
    );
    await expect(
      canvas.getByRole("button", { name: "Reset to default: Language" }),
    ).toBeVisible();
  },
};
