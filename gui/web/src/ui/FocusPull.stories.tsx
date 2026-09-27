import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Button } from "./Button";
import { FocusPull } from "./FocusPull";

function FocusPullPreview() {
  const [view, setView] = useState<"first" | "second">("first");
  return (
    <>
      <Button
        type="button"
        onClick={() => setView((v) => (v === "first" ? "second" : "first"))}
      >
        Switch view
      </Button>
      <FocusPull viewKey={view}>
        {view === "first" ? <p>First view</p> : <p>Second view</p>}
      </FocusPull>
    </>
  );
}

const meta: Meta<typeof FocusPull> = {
  title: "Molecules/FocusPull",
  render: () => <FocusPullPreview />,
};

export default meta;
type Story = StoryObj<typeof FocusPull>;

export const Initial: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("First view")).toBeVisible();
    expect(canvasElement.querySelector(".focus-pull-enter")).toBeNull();
  },
};

export const Transition: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Switch view" }));
    await waitFor(
      () => {
        expect(canvas.getByText("Second view")).toBeVisible();
        expect(canvas.queryByText("First view")).toBeNull();
      },
      { timeout: 2000 },
    );
  },
};
