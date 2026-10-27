import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { ScriptDivider } from "./ScriptDivider";
import { clampScriptWidth, SCRIPT_WIDTH_DEFAULT_REM } from "./useScriptSize";

function Harness() {
  const [rem, setRem] = useState(SCRIPT_WIDTH_DEFAULT_REM);
  return (
    <div style={{ display: "flex", blockSize: "6rem" }}>
      <div style={{ flex: 1 }}>Timeline</div>
      <ScriptDivider
        widthRem={rem}
        onResize={(next) => setRem(clampScriptWidth(next))}
        onReset={() => setRem(SCRIPT_WIDTH_DEFAULT_REM)}
      />
      <div style={{ flex: `0 0 ${rem}rem` }}>Script, {rem} rem</div>
    </div>
  );
}

const meta: Meta<typeof ScriptDivider> = {
  title: "Stages/Edit/Divider",
  component: ScriptDivider,
  tags: ["wide-only"],
  parameters: {
    wideOnlyReason:
      "The divider only exists between the timeline and the Script pane side by side; a phone shows one surface.",
    docs: {
      description: {
        component:
          "The plain divider between the timeline and the Script pane: drag it, press the arrow keys (1 rem, Shift 4 rem), or press Enter or double-click to reset. No text buttons.\n\n**Motion.** None; the pane follows the pointer without easing.",
      },
    },
  },
  render: () => <Harness />,
};

export default meta;
type Story = StoryObj<typeof ScriptDivider>;

export const SideBySide: Story = {
  play: async ({ canvasElement }) => {
    const divider = within(canvasElement).getByRole("separator", {
      name: "Resize Script",
    });
    divider.focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(divider).toHaveAttribute("aria-valuenow", "26");
    await userEvent.keyboard("{Enter}");
    await expect(divider).toHaveAttribute("aria-valuenow", "25");
  },
};

export const AtWidest: Story = {
  play: async ({ canvasElement }) => {
    const divider = within(canvasElement).getByRole("separator", {
      name: "Resize Script",
    });
    divider.focus();
    for (let i = 0; i < 6; i += 1) {
      await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    }
    await expect(divider).toHaveAttribute("aria-valuenow", "40");
  },
};
