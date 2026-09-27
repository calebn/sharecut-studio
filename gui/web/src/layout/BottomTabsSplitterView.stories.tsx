import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DEFAULT_TABS_HEIGHT_REM } from "../hooks/useTabsHeight";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import {
  BottomTabsSplitterView,
  type BottomTabsSplitterViewProps,
} from "./BottomTabsSplitterView";

const meta: Meta<typeof BottomTabsSplitterView> = {
  title: "Templates/BottomTabsSplitter",
  component: BottomTabsSplitterView,
  tags: ["autodocs"],
  decorators: [
    (Story, context) => (
      <section
        className="bottom-tabs"
        aria-label="Editor panels preview"
        style={{
          width: context.parameters.splitterPhone ? "360px" : "48rem",
          height: "12.5rem",
        }}
      >
        <Story />
      </section>
    ),
  ],
  args: {
    heightRem: 12.5,
    minRem: 8,
    maxRem: 24,
    userSet: false,
    onResize: fn(),
    onReset: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof BottomTabsSplitterView>;

function SplitterPreview(args: BottomTabsSplitterViewProps) {
  const [heightRem, setHeightRem] = useState(args.heightRem);
  const [userSet, setUserSet] = useState(args.userSet);
  return (
    <BottomTabsSplitterView
      {...args}
      heightRem={heightRem}
      userSet={userSet}
      onResize={(rem) => {
        setHeightRem(Math.min(args.maxRem, Math.max(args.minRem, rem)));
        setUserSet(true);
        args.onResize(rem);
      }}
      onReset={() => {
        setHeightRem(DEFAULT_TABS_HEIGHT_REM);
        setUserSet(false);
        args.onReset();
      }}
    />
  );
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    await expect(sep).toHaveAttribute("aria-valuenow", "12.5");
    await expect(sep).toHaveAttribute("aria-valuemax", "24");
    await expect(sep).toHaveAttribute(
      "aria-valuetext",
      "12.5 rem (default 12.5)",
    );
  },
};

export const CustomHeight: Story = {
  args: { heightRem: 20, maxRem: 20, userSet: true },
  play: async ({ canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    await expect(sep).toHaveAttribute("aria-valuenow", "20");
    await expect(sep).toHaveAttribute("aria-valuemax", "20");
  },
};

export const KeyboardResize: Story = {
  args: { heightRem: 14, userSet: true },
  render: (args) => <SplitterPreview {...args} />,
  play: async ({ args, canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect(args.onResize).toHaveBeenCalledWith(15);
    await expect(sep).toHaveAttribute("aria-valuenow", "15");
    await userEvent.keyboard("{Enter}");
    await expect(args.onReset).toHaveBeenCalled();
    await expect(sep).toHaveAttribute("aria-valuenow", "12.5");
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, splitterPhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector(".bottom-tabs")).toHaveStyle({
      width: "360px",
    });
    await expect(
      within(canvasElement).getByRole("separator", {
        name: "Resize editor panels",
      }),
    ).toBeInTheDocument();
    await expect(
      canvasElement.querySelector(".bottom-tabs-splitter-grip"),
    ).toHaveAttribute("aria-hidden");
  },
};
