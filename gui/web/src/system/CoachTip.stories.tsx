import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { viewportStoryParameters } from "../storybook/storyLayout";
import { Button } from "../ui";
import { CoachTip } from "./CoachTip";

const meta: Meta<typeof CoachTip> = {
  title: "System/CoachTip",
  component: CoachTip,
  tags: ["autodocs"],
  parameters: {
    ...viewportStoryParameters,
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          'A one-line hint anchored to an element, shown once at the moment of first need and dismissed by any action. The caller owns "shown once"; the story keeps no storage.\n\n**Motion.** Fades in with `--motion-state` and out with `--motion-hover` in the animation pass; not implemented in this slice.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof CoachTip>;

function Demo({ placement }: { placement: "below" | "above" }) {
  const [shown, setShown] = useState(true);
  return (
    <div
      style={{
        paddingBlock:
          placement === "above"
            ? "calc(var(--space-8) + var(--space-8))"
            : "var(--space-8)",
        paddingInline: "var(--space-5)",
        display: "flex",
        justifyContent: "flex-start",
      }}
    >
      <CoachTip
        text="Solo is just for your ears"
        placement={placement}
        shown={shown}
        onDismiss={() => setShown(false)}
      >
        <Button>Solo</Button>
      </CoachTip>
    </div>
  );
}

export const Below: Story = {
  render: () => <Demo placement="below" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("note")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Dismiss hint" }));
    await expect(canvas.queryByRole("note")).toBeNull();
    // The close button unmounted with the tip; focus goes back to the anchor.
    await expect(canvas.getByRole("button", { name: "Solo" })).toHaveFocus();
  },
};

export const Above: Story = { render: () => <Demo placement="above" /> };

export const DismissedByAction: Story = {
  render: () => <Demo placement="below" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("note")).toHaveTextContent(
      "Solo is just for your ears",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Solo" }));
    await expect(canvas.queryByRole("note")).toBeNull();
  },
};
