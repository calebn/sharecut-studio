import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { useArgState } from "../test/storyDialog";
import { GuestNameStep } from "./GuestNameStep";

function GuestNameStepPreview(args: ComponentProps<typeof GuestNameStep>) {
  const [name, setName] = useArgState(args.name);
  return (
    <GuestNameStep
      {...args}
      name={name}
      onNameChange={(next) => {
        setName(next);
        args.onNameChange(next);
      }}
    />
  );
}

const meta: Meta<typeof GuestNameStep> = {
  title: "Templates/GuestNameStep",
  component: GuestNameStep,
  tags: ["autodocs"],
  args: {
    name: "",
    onNameChange: fn(),
    onConfirm: fn(),
    onPostAsGuest: fn(),
    busy: false,
  },
  render: (args) => <GuestNameStepPreview {...args} />,
};

export default meta;
type Story = StoryObj<typeof GuestNameStep>;

export const Empty: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Your name")).toHaveFocus();
    await userEvent.type(canvas.getByLabelText("Your name"), "Bo");
    await expect(args.onNameChange).toHaveBeenLastCalledWith("Bo");
    await userEvent.click(
      canvas.getByRole("button", { name: "Post as Guest" }),
    );
    await expect(args.onPostAsGuest).toHaveBeenCalledOnce();
  },
};

export const Named: Story = {
  args: { name: "Bo" },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Post comment" }),
    );
    await expect(args.onConfirm).toHaveBeenCalledOnce();
  },
};

export const Posting: Story = {
  args: { name: "Bo", busy: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Posting…" }),
    ).toBeDisabled();
  },
};
