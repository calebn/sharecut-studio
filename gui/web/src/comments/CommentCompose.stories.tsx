import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { recordMobileViewport } from "../record/recordStoryDecorator";
import { CommentCompose } from "./CommentCompose";

type Args = Parameters<typeof CommentCompose>[0];

function ComposeHarness(args: Args) {
  const [body, setBody] = useState(args.body);
  const [author, setAuthor] = useState(args.author);
  return (
    <div className="comments-panel">
      <CommentCompose
        {...args}
        body={body}
        author={author}
        submitDisabled={args.submitDisabled || !body.trim()}
        onBodyChange={(value) => {
          setBody(value);
          args.onBodyChange(value);
        }}
        onAuthorChange={
          args.onAuthorChange
            ? (value) => {
                setAuthor(value);
                args.onAuthorChange?.(value);
              }
            : undefined
        }
      />
    </div>
  );
}

const meta: Meta<typeof CommentCompose> = {
  title: "Templates/CommentCompose",
  component: CommentCompose,
  tags: ["autodocs"],
  render: (args) => <ComposeHarness {...args} />,
  args: {
    body: "",
    onBodyChange: fn(),
    onSubmit: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof CommentCompose>;

export const Empty: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByRole("button", { name: "Post comment" });
    await expect(submit).toBeDisabled();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Comment" }),
      "Keep this pause.",
    );
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect(args.onSubmit).toHaveBeenCalled();
  },
};

export const GuestFeedback: Story = {
  args: {
    body: "The opening sounds clear.",
    author: "Mira",
    onAuthorChange: fn(),
    bodyPlaceholder: "Leave feedback…",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("textbox", { name: "Your name" }),
    ).toHaveValue("Mira");
    await expect(canvas.getByRole("textbox", { name: "Comment" })).toHaveValue(
      "The opening sounds clear.",
    );
  },
};

export const Posting: Story = {
  args: { body: "Check the opening.", busy: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Posting…" }),
    ).toBeDisabled();
  },
};

export const MobileGuestFeedback: Story = {
  parameters: recordMobileViewport.parameters,
  globals: recordMobileViewport.globals,
  args: {
    body: "The pause before the second answer makes the scene easier to follow.",
    author: "Bo",
    onAuthorChange: fn(),
    bodyPlaceholder: "Leave feedback…",
  },
};
