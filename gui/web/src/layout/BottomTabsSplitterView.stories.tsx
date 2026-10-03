import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  clampTabsHeightRem,
  DEFAULT_TABS_HEIGHT_REM,
  MIN_TABS_HEIGHT_REM,
} from "../hooks/useTabsHeight";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import {
  BottomTabsSplitterView,
  type BottomTabsSplitterViewProps,
} from "./BottomTabsSplitterView";

/**
 * Fixed shell space below transport + status for stories. With the production
 * 0.6 max fraction this caps the band at 384px (24rem at a 16px root).
 */
const STORY_AVAILABLE_PX = 640;
const STORY_MAX_REM = clampTabsHeightRem(999, STORY_AVAILABLE_PX);

const meta: Meta<typeof BottomTabsSplitterView> = {
  title: "Templates/BottomTabsSplitter",
  component: BottomTabsSplitterView,
  tags: ["autodocs"],
  render: (args, context) => (
    <SplitterPreview
      {...args}
      phone={context.parameters.splitterPhone === true}
    />
  ),
  args: {
    heightRem: DEFAULT_TABS_HEIGHT_REM,
    minRem: MIN_TABS_HEIGHT_REM,
    maxRem: STORY_MAX_REM,
    userSet: false,
    onResize: fn(),
    onReset: fn(),
  },
};
export default meta;
type Story = StoryObj<typeof BottomTabsSplitterView>;

function SplitterPreview({
  phone = false,
  ...args
}: BottomTabsSplitterViewProps & { phone?: boolean }) {
  const [heightRem, setHeightRem] = useState(args.heightRem);
  const [userSet, setUserSet] = useState(args.userSet);
  return (
    <section
      className="bottom-tabs"
      aria-label="Editor panels preview"
      style={{
        width: phone ? "360px" : "48rem",
        maxWidth: "100%",
        height: `${heightRem}rem`,
      }}
    >
      <BottomTabsSplitterView
        {...args}
        heightRem={heightRem}
        userSet={userSet}
        onResize={(rem) => {
          setHeightRem(
            Math.min(
              args.maxRem,
              Math.max(
                args.minRem,
                clampTabsHeightRem(rem, STORY_AVAILABLE_PX),
              ),
            ),
          );
          setUserSet(true);
          args.onResize(rem);
        }}
        onReset={() => {
          setHeightRem(DEFAULT_TABS_HEIGHT_REM);
          setUserSet(false);
          args.onReset();
        }}
      />
    </section>
  );
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    await expect(sep).toHaveAttribute("aria-valuenow", "12.5");
    await expect(sep).toHaveAttribute("aria-valuemax", "24");
    await expect(sep).toHaveAttribute("aria-valuetext", "12.5 rem");
    await expect(sep.parentElement?.style.height).toBe("12.5rem");
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
    await expect(sep.parentElement?.style.height).toBe("20rem");
  },
};

export const KeyboardResize: Story = {
  args: { heightRem: 14, userSet: true },
  play: async ({ args, canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect(args.onResize).toHaveBeenCalledWith(15);
    await expect(sep).toHaveAttribute("aria-valuenow", "15");
    await expect(sep.parentElement?.style.height).toBe("15rem");
    await userEvent.keyboard("{Enter}");
    await expect(args.onReset).toHaveBeenCalled();
    await expect(sep).toHaveAttribute("aria-valuenow", "12.5");
    await expect(sep.parentElement?.style.height).toBe("12.5rem");
  },
};

export const KeyboardResizeCustomMax: Story = {
  args: { heightRem: 19.5, maxRem: 20, userSet: true },
  play: async ({ args, canvasElement }) => {
    const sep = within(canvasElement).getByRole("separator", {
      name: "Resize editor panels",
    });
    sep.focus();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    await expect(args.onResize).toHaveBeenCalledWith(20.5);
    await expect(sep).toHaveAttribute("aria-valuemax", "20");
    await expect(sep).toHaveAttribute("aria-valuenow", "20");
    await expect(sep.parentElement?.style.height).toBe("20rem");
  },
};

export const PhoneWidth: Story = {
  parameters: { ...recordMobileViewport.parameters, splitterPhone: true },
  globals: recordMobileViewport.globals,
  play: async ({ canvasElement }) => {
    const panel = canvasElement.querySelector<HTMLElement>(".bottom-tabs");
    await expect(panel?.getBoundingClientRect().width).toBeLessThanOrEqual(360);
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
