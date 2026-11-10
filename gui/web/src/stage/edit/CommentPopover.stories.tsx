import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState } from "react";
import { expect, fn, within } from "storybook/test";
import { viewportStoryParameters } from "../../storybook/storyLayout";
import { InspectorSheet } from "../../system/InspectorSheet";
import { episode } from "../../test/episodeFixture";
import { episodeBeforeEach, withEpisode } from "../../test/withEpisode";
import type { Selection } from "../../types/project";
import { CommentPopover } from "./CommentPopover";
import { useCommentSections } from "./commentSections";

const comment = (id: string): Selection => ({ kind: "comment", id });

function PopoverHost({ id }: { id: string }) {
  const pin = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  return (
    <div style={{ padding: "6rem 0 0 8rem" }}>
      <button
        ref={pin}
        type="button"
        data-testid="comment-pin"
        aria-label="Comment pin"
      >
        <span aria-hidden="true">{"\u{1F4AC}"}</span>
      </button>
      <CommentPopover
        commentId={id}
        anchor={{ ref: pin, moves: [], clearTop: () => 0 }}
        root={null}
        panelRef={panel}
        away={false}
        onClose={fn()}
      />
    </div>
  );
}

function SheetHost({ id }: { id: string }) {
  const sections = useCommentSections(comment(id)) ?? [];
  const [detent, setDetent] = useState<"half" | "full" | "dock">("half");
  return (
    <InspectorSheet
      form="phone"
      icon="message-square"
      name="Comment"
      label="Inspector"
      sections={sections}
      detent={detent}
      onDetentChange={setDetent}
      onDismiss={fn()}
      onClose={fn()}
    />
  );
}

const meta: Meta = {
  title: "Stages/Edit/CommentPopover",
  beforeEach: episodeBeforeEach,
  decorators: [withEpisode],
  render: () => <PopoverHost id="comment-2" />,
  parameters: {
    ...viewportStoryParameters,
    episode: {
      project: episode(),
      role: "host",
      selection: comment("comment-2"),
    },
    docs: {
      ...viewportStoryParameters.docs,
      description: {
        component:
          "A selected comment opened with Inspect: the shared comment card in a 320 px panel beside its pin, with replies, action items and a Reply field that sends on Enter. Resolve and Remove stay on the Action bar; a resolved comment shows Reopen to the host. A Viewer link sees the thread alone, a Commenter link may reply, and neither sees Reopen. The phone keeps the thread in the Inspector bottom sheet.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement.ownerDocument.body);
    await expect(
      await panel.findByText("Great story, keep it all."),
    ).toBeVisible();
    await expect(
      panel.getByRole("textbox", { name: "Reply to Ines" }),
    ).toBeVisible();
    await expect(panel.queryByRole("button", { name: "Resolve" })).toBeNull();
    await expect(panel.queryByRole("button", { name: "Reopen" })).toBeNull();
  },
};

export const WithReplies: Story = {
  render: () => <PopoverHost id="comment-1" />,
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: comment("comment-1"),
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement.ownerDocument.body);
    await expect(
      await panel.findByText("Can we trim the pause before this answer?"),
    ).toBeVisible();
    await expect(
      panel.getByRole("checkbox", { name: "Review the cut" }),
    ).toBeVisible();
  },
};

export const Resolved: Story = {
  render: () => <PopoverHost id="comment-3" />,
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: comment("comment-3"),
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement.ownerDocument.body);
    await expect(await panel.findByText("Resolved by Mira")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Reopen" })).toBeVisible();
  },
};

export const ViewerLink: Story = {
  render: () => <PopoverHost id="comment-3" />,
  parameters: {
    episode: {
      project: episode(),
      role: "viewer",
      selection: comment("comment-3"),
    },
  },
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement.ownerDocument.body);
    await expect(await panel.findByText("Resolved by Mira")).toBeVisible();
    await expect(panel.queryByRole("button", { name: "Reopen" })).toBeNull();
    await expect(panel.queryByRole("textbox")).toBeNull();
  },
};

export const Phone: Story = {
  render: () => <SheetHost id="comment-1" />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: comment("comment-1"),
    },
  },
  play: async ({ canvasElement }) => {
    const sheet = within(canvasElement);
    await expect(
      await sheet.findByRole("textbox", { name: "Reply to Ines" }),
    ).toBeVisible();
  },
};

export const PhoneResolved: Story = {
  render: () => <SheetHost id="comment-3" />,
  globals: { viewport: { value: "mobile360", isRotated: false } },
  parameters: {
    episode: {
      project: episode(),
      role: "host",
      selection: comment("comment-3"),
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Reopen" }),
    ).toBeVisible();
  },
};
