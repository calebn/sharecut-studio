import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import "../styles/partials/review-entry.css";
import { recordMobileViewport } from "../record/recordStoryDecorator";
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

function GuestCompose(args: Args) {
  return (
    <div className="cover review-shell">
      <div className="cover-center center stack">
        <ComposeHarness {...args} className="review-compose box elevated" />
      </div>
    </div>
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

export const GuestFeedback: Story = {
  render: (args) => (
    <GuestCompose key={JSON.stringify([args.body, args.author])} {...args} />
  ),
  parameters: { layout: "fullscreen" },
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
  render: (args) => (
    <GuestCompose key={JSON.stringify([args.body, args.author])} {...args} />
  ),
  parameters: { ...recordMobileViewport.parameters, layout: "fullscreen" },
  globals: recordMobileViewport.globals,
  args: {
    body: "The pause before the second answer makes the scene easier to follow.",
    author: "Bo",
    onAuthorChange: fn(),
    bodyPlaceholder: "Leave feedback…",
  },
};
