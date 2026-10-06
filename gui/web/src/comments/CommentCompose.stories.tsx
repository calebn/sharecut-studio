import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { CommentCompose } from "./CommentCompose";

type Args = Parameters<typeof CommentCompose>[0];

function ComposeHarness({
  clearOnSubmit = false,
  ...args
}: Args & { clearOnSubmit?: boolean }) {
  const [body, setBody] = useState(args.body);
  const [author, setAuthor] = useState(args.author);
  return (
    <CommentCompose
      {...args}
      body={body}
      author={author}
      onBodyChange={(value) => {
        setBody(value);
        args.onBodyChange(value);
      }}
      onSubmit={() => {
        args.onSubmit();
        if (clearOnSubmit) setBody("");
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
  );
}

const meta: Meta<typeof CommentCompose> = {
  title: "Templates/CommentCompose",
  component: CommentCompose,
  tags: ["autodocs"],
  render: (args) => (
    <div className="comments-panel">
      <ComposeHarness
        key={JSON.stringify([args.body, args.author])}
        {...args}
      />
    </div>
  ),
  args: {
    body: "",
    onBodyChange: fn(),
    onSubmit: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof CommentCompose>;

export const Empty: Story = {
  args: { submitDisabled: true },
  parameters: {
    docs: {
      description: {
        story: "An empty draft with posting explicitly disabled by its caller.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByRole("button", { name: "Post comment" });
    await expect(submit).toBeDisabled();
    await expect(canvas.getByRole("textbox", { name: "Comment" })).toHaveValue(
      "",
    );
  },
};

export const DraftAndPost: Story = {
  render: (args) => (
    <div className="comments-panel">
      <ComposeHarness
        key={JSON.stringify([args.body, args.author])}
        {...args}
        clearOnSubmit
      />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const submit = canvas.getByRole("button", { name: "Post comment" });
    await expect(submit).toBeEnabled();
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Comment" }),
      "Keep this pause.",
    );
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect(args.onSubmit).toHaveBeenCalled();
    await expect(canvas.getByRole("textbox", { name: "Comment" })).toHaveValue(
      "",
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
