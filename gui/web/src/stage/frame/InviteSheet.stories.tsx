import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { shareOptionsFixture } from "../../stages/deliver/shareFixture";
import { LISTEN_CHOICES } from "../../stages/deliver/shareLogic";
import { isolatedStoryParameters } from "../../storybook/storyLayout";
import { DialogLauncher } from "../../test/DialogLauncher";
import { hostShareRow } from "../../test/fixtures";
import { openDialogByLauncher } from "../../test/storyDialog";
import type { TunnelStatus } from "../../types/tunnel";
import { InviteSheetView } from "./InviteSheet";

const meta: Meta<typeof InviteSheetView> = {
  title: "Stages/Frame/InviteSheet",
  component: InviteSheetView,
  tags: ["autodocs"],
  args: {
    options: shareOptionsFixture(),
    form: "centered",
    onClose: fn(),
  },
  parameters: {
    ...isolatedStoryParameters,
    docs: {
      ...isolatedStoryParameters.docs,
      description: {
        component:
          "One sharing object, opened from the header Invite on every stage: a Sheet of Link rows grouped Review links, Record links and Listen link. There is no Create button. Each group opens with a ready row at its default (Review: Commenter, following the latest; Listen: Viewer, pinned to the version current when you copy it), and the link is made on its first Copy. The Record empty Person tile opens the sheet at Record links. Deliver embeds the Listen link row in place. On a phone it is a bottom sheet.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof InviteSheetView>;

const REVIEW = hostShareRow({
  token: "rv-1",
  url: "https://share.example.app/r/Hq2mXk9TnP4vLr8Za3w",
  created_at: "2026-09-01T10:00:00Z",
});
const EDITOR = hostShareRow({
  token: "rv-2",
  url: "https://share.example.app/r/Zk4sB7nQ2wLd9TcX5hP",
  docs_role: "editor",
  mcp_url: "https://share.example.app/mcp/rv-2/mcp",
  follow_latest: false,
  review_version_label: "Rough cut",
});
const LISTEN = hostShareRow({
  token: "ls-1",
  url: "https://share.example.app/r/Lp8vC3mR6yNt2QaJ7dK",
  docs_role: "viewer",
  follow_latest: false,
  review_version_label: "Rough cut",
});
const GUEST = hostShareRow({
  token: "rec-g1",
  url: "https://share.example.app/rec/guest-1",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "room-1",
  created_at: "2026-09-01T10:00:00Z",
});
const PRODUCER = hostShareRow({
  token: "rec-p1",
  url: "https://share.example.app/rec/producer-1",
  kind: "record",
  docs_role: null,
  record_role: "producer",
  session_id: "room-1",
});

const tunnel = (state: TunnelStatus["state"]): TunnelStatus => ({
  state,
  reason: null,
  reason_kind: null,
  relay_host: "relay.example.test",
  public_base_url: "https://share.example.test",
  share_count: 1,
  retry_at: null,
});

/** The dialog form opens from a launcher; the phone bottom sheet from its own. */
function launched(
  open: (canvasElement: HTMLElement) => Promise<HTMLElement>,
  after?: (dialog: HTMLElement, args: Story["args"]) => Promise<void>,
): Pick<Story, "render" | "play"> {
  return {
    render: (args) => (
      <DialogLauncher label="Open invite" initiallyOpen={false}>
        {(isOpen, close) => (
          <InviteSheetView {...args} open={isOpen} onClose={close} />
        )}
      </DialogLauncher>
    ),
    play: async ({ canvasElement, args, viewMode }) => {
      if (viewMode === "docs") return;
      const dialog = await open(canvasElement);
      await after?.(dialog, args);
    },
  };
}

const openInvite = (canvasElement: HTMLElement) =>
  openDialogByLauncher(canvasElement, {
    launcherName: "Open invite",
    dialogName: "Invite",
  });

export const Fresh: Story = {
  args: { options: shareOptionsFixture({ onCreate: fn() }) },
  ...launched(openInvite, async (dialog, args) => {
    const view = within(dialog);
    await waitFor(() =>
      expect(
        view.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
      ).toEqual(["Review links", "Record links", "Listen link"]),
    );
    await expect(
      view.queryByRole("button", { name: /Create review/ }),
    ).toBeNull();
    await userEvent.click(
      view.getByRole("button", { name: "Copy new Commenter link" }),
    );
    await expect(args?.options?.onCreate).toHaveBeenCalledOnce();
    await userEvent.click(
      view.getByRole("button", { name: "Copy listen link" }),
    );
    await expect(args?.options?.onCreate).toHaveBeenLastCalledWith(
      LISTEN_CHOICES,
    );
  }),
};

export const WithLinks: Story = {
  args: {
    options: shareOptionsFixture({
      rows: [REVIEW, EDITOR, LISTEN, GUEST, PRODUCER],
      copiedKey: "link:rv-1",
    }),
  },
  ...launched(openInvite, async (dialog) => {
    const view = within(dialog);
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Copied Commenter link" }),
      ).toBeVisible(),
    );
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Copy listen link" }),
      ).toBeVisible(),
    );
    await waitFor(() => expect(view.getByText("Record room")).toBeVisible());
  }),
};

export const AtRecordLinks: Story = {
  args: {
    at: "record",
    options: shareOptionsFixture({ rows: [GUEST, PRODUCER] }),
  },
  ...launched(openInvite, async (dialog) => {
    const heading = within(dialog).getByRole("heading", {
      name: "Record links",
    });
    await waitFor(() => expect(heading).toHaveFocus());
  }),
};

export const RecordRoomOpenRecord: Story = {
  args: {
    options: shareOptionsFixture({
      rows: [GUEST, PRODUCER],
      onOpenRecord: fn(),
    }),
  },
  ...launched(openInvite, async (dialog, args) => {
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Open Record stage" }),
    );
    await expect(args?.options?.onOpenRecord).toHaveBeenCalledOnce();
  }),
};

export const StopSharing: Story = {
  args: { options: shareOptionsFixture({ rows: [REVIEW], onStop: fn() }) },
  ...launched(openInvite, async (dialog, args) => {
    const view = within(dialog);
    await userEvent.click(
      view.getByRole("button", { name: "More for Commenter link" }),
    );
    await userEvent.click(
      await within(document.body).findByRole("menuitem", {
        name: "Stop sharing",
      }),
    );
    await expect(args?.options?.onStop).toHaveBeenCalledWith(
      "rv-1",
      expect.any(Function),
    );
    await expect(view.queryByRole("button", { name: "Keep link" })).toBeNull();
  }),
};

export const EndRoom: Story = {
  args: {
    options: shareOptionsFixture({
      rows: [GUEST, PRODUCER],
      onEndRoom: fn(),
    }),
  },
  ...launched(openInvite, async (dialog, args) => {
    const view = within(dialog);
    await userEvent.click(view.getByRole("button", { name: "End room" }));
    await expect(args?.options?.onEndRoom).toHaveBeenCalledOnce();
    await expect(view.queryByRole("button", { name: "Keep room" })).toBeNull();
  }),
};

export const NoMix: Story = {
  args: {
    options: shareOptionsFixture({
      recovery: {
        kind: "needs_refresh",
        message:
          "This project has no mix yet. Refresh the mix to create the link.",
        refreshError: null,
      },
      refreshFor: {
        choices: { role: "commenter", withMcp: false, freeze: false },
        listen: false,
      },
      onRefreshMix: fn(),
    }),
  },
  ...launched(openInvite, async (dialog, args) => {
    const view = within(dialog);
    await waitFor(() =>
      expect(view.getByText("Make a mix to share")).toBeVisible(),
    );
    await userEvent.click(view.getByRole("button", { name: "Refresh mix" }));
    await expect(args?.options?.onRefreshMix).toHaveBeenCalledOnce();
  }),
};

export const ClipboardBlocked: Story = {
  args: {
    options: shareOptionsFixture({ rows: [REVIEW], blockedKey: "link:rv-1" }),
  },
  ...launched(openInvite, async (dialog) => {
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: /^Press / }),
      ).toBeVisible(),
    );
  }),
};

export const OfflineOnly: Story = {
  args: {
    options: shareOptionsFixture({
      rows: [
        hostShareRow({
          ...REVIEW,
          url: "http://192.168.1.20:8765/r/Hq2mXk9TnP4vLr8Za3w",
        }),
      ],
      tunnel: tunnel("off"),
    }),
  },
  ...launched(openInvite, async (dialog) => {
    const view = within(dialog);
    await waitFor(() =>
      expect(view.getByText("Online sharing is off")).toBeVisible(),
    );
    const glyph = view.getByRole("button", { name: "Only on this network" });
    await userEvent.click(glyph);
    await waitFor(() =>
      expect(
        view.getByText(/Only people on this network can open it/),
      ).toBeVisible(),
    );
  }),
};

const tunnelStory = (
  state: TunnelStatus["state"],
  headline: RegExp | string,
): Story => ({
  args: {
    options: shareOptionsFixture({
      rows: [REVIEW],
      tunnel: tunnel(state),
    }),
  },
  ...launched(openInvite, async (dialog) => {
    await waitFor(() =>
      expect(within(dialog).getByText(headline)).toBeVisible(),
    );
  }),
});

export const OnlineSharingOn: Story = tunnelStory(
  "online",
  "Guests can open your links",
);
export const OnlineSharingReconnecting: Story = tunnelStory(
  "reconnecting",
  /^Reconnecting…/,
);
export const OnlineSharingNotReachable: Story = tunnelStory(
  "offline",
  /^Not reachable online/,
);

export const Busy: Story = {
  args: { options: shareOptionsFixture({ rows: [REVIEW], busy: true }) },
  ...launched(openInvite, async (dialog) => {
    await expect(
      within(dialog).getByRole("button", { name: "Copy Commenter link" }),
    ).toBeDisabled();
  }),
};

function PhoneLauncher(args: React.ComponentProps<typeof InviteSheetView>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open invite
      </button>
      <InviteSheetView {...args} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export const Phone: Story = {
  args: {
    form: "bottom",
    detent: "full",
    options: shareOptionsFixture({ rows: [REVIEW, LISTEN, GUEST, PRODUCER] }),
  },
  render: (args) => <PhoneLauncher {...args} />,
  play: async ({ canvasElement, viewMode }) => {
    if (viewMode === "docs") return;
    const dialog = await openInvite(canvasElement);
    await waitFor(() =>
      expect(
        within(dialog).getByRole("heading", { name: "Listen link" }),
      ).toBeVisible(),
    );
  },
};
