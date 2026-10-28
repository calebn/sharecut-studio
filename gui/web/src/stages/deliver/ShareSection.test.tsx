import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { hostShareRow } from "../../test/fixtures";
import type { TunnelStatus } from "../../types/tunnel";
import { ShareSection } from "./ShareSection";
import {
  AGENT_ROW,
  GUEST_ROW,
  ONLINE,
  PRODUCER_ROW,
  REVIEW_ROW,
  REVOKED_ROW,
  shareOptions,
} from "./shareFixture";
import { type ShareOptions, shareCopyKey } from "./shareLogic";

const ROWS = [REVIEW_ROW, AGENT_ROW, GUEST_ROW, PRODUCER_ROW, REVOKED_ROW];

function setup(
  overrides: Partial<ShareOptions> = {},
  props: Partial<React.ComponentProps<typeof ShareSection>> = {},
) {
  const options = shareOptions(() => vi.fn(), { rows: ROWS, ...overrides });
  const view = render(<ShareSection options={options} {...props} />);
  return { options, ...view };
}

function reviewItems() {
  return within(
    screen.getByRole("region", { name: "Review links" }),
  ).getAllByRole("listitem");
}

function stopButton() {
  return within(
    screen.getByText("Commenter link").closest("li") as HTMLElement,
  ).getByRole("button", { name: "Stop sharing" });
}

describe("the Share section", () => {
  it("is a Share section holding the roles, the review links and the record rooms; axe-clean", async () => {
    const { container } = setup();
    expect(
      screen.getByRole("heading", { name: "Share", level: 2 }),
    ).toBeVisible();
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Review links", "Record rooms"]);
    await expectNoA11yViolations(container);
  });

  it("names review links by role and keeps the slug as their address", () => {
    setup({
      rows: [
        hostShareRow({
          created_at: "2026-10-01T12:00:00Z",
          last_used_at: "2026-10-01T12:00:00Z",
        }),
        AGENT_ROW,
        GUEST_ROW,
        PRODUCER_ROW,
        REVOKED_ROW,
      ],
    });
    const items = reviewItems();
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(
        /^Commenterhttp:\/\/127\.0\.0…le-review-linkFollows latest: Share mix · Created .+sample-review-linkCopyCommenter linkStop sharing$/,
      ),
      "Editorhttp://127.0.0…ple-agent-linkAI assistants allowedsample-agent-linkCopyEditor linkCopy MCP URLStop sharing",
    ]);
    expect(items[0]).toHaveTextContent("Follows latest: Share mix · Created");
    expect(items[0]).toHaveTextContent("sample-review-link");
    expect(items[0]).not.toHaveTextContent("Last opened");
    expect(screen.queryByText("sample-stale-link")).not.toBeInTheDocument();
    expect(
      within(items[0]).getByRole("button", { name: "Copy" }),
    ).toHaveAccessibleDescription("Commenter link");
    expect(
      screen.getByText("Links don't expire. Stop sharing turns one off."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A guest link records the person who joins. A producer link lets your producer listen and comment without being recorded. Record links don't expire. End room turns them off.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/expiry/)).not.toBeInTheDocument();
  });

  it("shows when a link was last opened and a host-chosen expiry", () => {
    setup({
      rows: [
        hostShareRow({
          created_at: "2026-10-01T12:00:00Z",
          last_used_at: "2026-10-03T12:00:00Z",
          expires_at: "2026-12-01T12:00:00Z",
        }),
      ],
    });
    expect(
      screen.getByText(/^Follows latest: Share mix · Created/),
    ).toHaveTextContent(/Last opened .+ · Expires /);
  });

  it("says when a link is frozen on one version", () => {
    setup({
      rows: [
        hostShareRow({
          token: "sample-frozen-link",
          follow_latest: false,
          review_version_label: "Intro fix",
          created_at: "2026-10-01T12:00:00Z",
        }),
      ],
    });
    expect(
      screen.getByText(/^Frozen on Intro fix · Created/),
    ).toBeInTheDocument();
  });

  it("shows a link with no address, and a role it does not know, without a dead Copy", () => {
    setup({
      rows: [
        hostShareRow({ token: "no-address", url: null, docs_role: "viewer" }),
      ],
    });
    const copy = screen.getByRole("button", { name: "Copy" });
    expect(copy).toBeDisabled();
    expect(copy).toHaveAttribute(
      "title",
      "This link has no address to copy yet.",
    );
    expect(
      screen.getByText("This link has no address to copy yet."),
    ).toBeVisible();
  });

  describe("online sharing", () => {
    const status = (over: Partial<TunnelStatus>): TunnelStatus => ({
      ...ONLINE,
      ...over,
    });

    it("tells the host whether guests can reach their links; axe-clean", async () => {
      const { container } = setup({
        tunnel: status({
          state: "reconnecting",
          reason: "network: connection lost",
          reason_kind: "network",
        }),
      });
      const note = screen.getByRole("status");
      expect(note).toHaveTextContent(
        "Reconnecting… guests may see a brief interruption",
      );
      expect(note.textContent).not.toContain("connection lost");
      await expectNoA11yViolations(container);
    });

    it("shows no online sharing line when unavailable or for a local-only host", () => {
      const { rerender, options } = setup({ tunnel: null });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      rerender(
        <ShareSection
          options={{
            ...options,
            tunnel: status({
              state: "not_set_up",
              reason: "online sharing is not set up",
              relay_host: null,
              public_base_url: null,
              share_count: null,
            }),
          }}
        />,
      );
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    });

    it("says each link is for this network only, once per link, when reach is network", () => {
      setup({ reach: "network" });
      expect(
        screen.getAllByText(
          "Only people on this network can listen. Turn on online sharing to reach anyone.",
        ),
      ).toHaveLength(2);
    });

    it("says nothing about the network when links reach anywhere or reach is unknown", () => {
      const { rerender, options } = setup({ reach: "anywhere" });
      expect(screen.queryByText(/on this network/)).toBeNull();
      rerender(<ShareSection options={{ ...options, reach: undefined }} />);
      expect(screen.queryByText(/on this network/)).toBeNull();
    });
  });

  it("offers each review-link role with what it can do; axe-clean", async () => {
    const { container } = setup();
    const roles = screen.getByRole("group", { name: "Anyone with the link" });
    expect(
      within(roles)
        .getAllByRole("radio")
        .map((radio) => [
          radio.getAttribute("value"),
          (radio as HTMLInputElement).checked,
        ]),
    ).toEqual([
      ["viewer", false],
      ["commenter", true],
      ["editor", false],
    ]);
    expect(
      screen.getByRole("radio", { name: "Viewer" }),
    ).toHaveAccessibleDescription("Views and plays the project.");
    expect(
      screen.getByRole("radio", { name: "Commenter" }),
    ).toHaveAccessibleDescription(
      "Also comments and suggests edits for you or an Editor to approve.",
    );
    expect(
      screen.getByRole("radio", { name: "Editor" }),
    ).toHaveAccessibleDescription(
      "Also edits directly and approves or rejects suggestions.",
    );
    expect(
      screen.getByText(
        "Everyone with the link sees your cursor, selection, playhead, and viewport while they are in the session.",
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("discloses what Allow AI assistants (MCP) and Freeze grant, next to them; axe-clean", async () => {
    const { container } = setup();
    const mcp = screen.getByRole("checkbox", {
      name: "Allow AI assistants (MCP)",
    });
    expect(mcp).not.toBeChecked();
    expect(mcp).toHaveAccessibleDescription(
      "Paste into an MCP client such as Claude or ChatGPT. The assistant gets this link's permissions.",
    );
    const freeze = screen.getByRole("checkbox", {
      name: "Freeze on the current version",
    });
    expect(freeze).toHaveAccessibleDescription(
      "Guests keep hearing this version even after you publish a newer one. Off, the link follows the latest.",
    );
    await expectNoA11yViolations(container);
  });

  it("shows empty states; axe-clean", async () => {
    const { container } = setup({ rows: [] });
    expect(screen.getByText("No review links yet.")).toBeInTheDocument();
    expect(screen.getByText("No record rooms yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create record links" }),
    ).toBeEnabled();
    await expectNoA11yViolations(container);
  });

  it("shows a skeleton under the Share title while the page loads", () => {
    setup({}, { state: "loading" });
    expect(screen.getByRole("heading", { name: "Share" })).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a stale-mix recovery action, with a failed refresh; axe-clean", async () => {
    const user = userEvent.setup();
    const { options, container, rerender } = setup({
      createRecovery: {
        kind: "needs_refresh",
        message: "The preview is out of date.",
        refreshError: null,
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The preview is out of date.",
    );
    await user.click(screen.getByRole("button", { name: "Refresh mix" }));
    expect(options.onRefreshMix).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
    rerender(
      <ShareSection
        options={{
          ...options,
          createRecovery: {
            kind: "needs_refresh",
            message: "The preview is out of date.",
            refreshError: "Render busy",
          },
        }}
      />,
    );
    expect(screen.getByText("Refresh failed: Render busy")).toBeInTheDocument();
  });

  it("reports every control through its callback", async () => {
    const user = userEvent.setup();
    const { options } = setup();

    await user.click(screen.getByRole("radio", { name: "Editor" }));
    expect(options.onRole).toHaveBeenCalledWith("editor");
    await user.click(screen.getByLabelText("Allow AI assistants (MCP)"));
    expect(options.onWithMcp).toHaveBeenCalledWith(true);
    await user.click(screen.getByLabelText("Freeze on the current version"));
    expect(options.onFreeze).toHaveBeenCalledWith(true);
    await user.click(
      screen.getByRole("button", { name: "Create review link" }),
    );
    expect(options.onCreate).toHaveBeenCalledOnce();
    await user.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    expect(options.onCreateRecord).toHaveBeenCalledOnce();

    await user.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    expect(options.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-review-link",
      "Link",
      REVIEW_ROW.url,
    );
    await user.click(screen.getByRole("button", { name: "Copy MCP URL" }));
    expect(options.onCopy).toHaveBeenCalledWith(
      "mcp",
      "sample-agent-link",
      "MCP URL",
      AGENT_ROW.mcp_url,
    );
    await user.click(screen.getByRole("button", { name: "Copy guest link" }));
    expect(options.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-guest-link",
      "Guest link",
      GUEST_ROW.url,
    );
    await user.click(screen.getByRole("button", { name: "Open room panel" }));
    expect(options.onOpenRoomPanel).toHaveBeenCalledOnce();
  });

  it("confirms Stop sharing in place, naming the link and the consequence; axe-clean", async () => {
    const user = userEvent.setup();
    const { options, container } = setup();

    await user.click(stopButton());
    const confirm = screen.getByRole("group", {
      name: "Stop sharing this Commenter link? Anyone using it loses access.",
    });
    expect(
      within(confirm)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Keep link", "Stop sharing"]);
    expect(
      within(confirm).getByRole("button", { name: "Keep link" }),
    ).toHaveFocus();
    expect(options.onRevoke).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);

    await user.click(screen.getByRole("button", { name: "Keep link" }));
    expect(screen.queryByRole("group", { name: /^Stop sharing/ })).toBeNull();
    expect(stopButton()).toHaveFocus();
    expect(options.onRevoke).not.toHaveBeenCalled();

    await user.click(stopButton());
    await user.click(
      within(
        screen.getByRole("group", { name: /^Stop sharing this Commenter/ }),
      ).getByRole("button", { name: "Stop sharing" }),
    );
    expect(options.onRevoke).toHaveBeenCalledExactlyOnceWith(
      "sample-review-link",
    );
    expect(screen.getByRole("heading", { name: "Review links" })).toHaveFocus();
  });

  it("keeps the link on Escape while a Stop sharing confirm is open", async () => {
    const user = userEvent.setup();
    const { options } = setup();
    await user.click(stopButton());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /^Stop sharing/ })).toBeNull();
    expect(stopButton()).toHaveFocus();
    expect(options.onRevoke).not.toHaveBeenCalled();
  });

  it("puts room actions in one room row, End room last and confirmed; axe-clean", async () => {
    const user = userEvent.setup();
    const { options, container } = setup();
    const room = screen.getByText("Record room").closest("li") as HTMLElement;
    const endRoom = within(room).getByRole("button", { name: "End room" });
    expect(endRoom.closest(".dv-share-link")).toBeNull();
    expect(
      [...(endRoom.parentElement?.children ?? [])].map((b) => b.textContent),
    ).toEqual(["Open room panel", "End room"]);

    await user.click(endRoom);
    const confirm = screen.getByRole("group", {
      name: "End this record room? Both guest and producer links will stop working.",
    });
    expect(
      within(confirm).getByRole("button", { name: "Keep room" }),
    ).toHaveFocus();
    await expectNoA11yViolations(container);
    expect(options.onEndRoom).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "End room" }));
    expect(options.onEndRoom).toHaveBeenCalledExactlyOnceWith("sample-room");
    expect(screen.getByRole("heading", { name: "Record rooms" })).toHaveFocus();
  });

  it("keeps the room on Escape while an End room confirm is open", async () => {
    const user = userEvent.setup();
    const { options } = setup();
    await user.click(screen.getByRole("button", { name: "End room" }));
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("group", { name: /^End this record room/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "End room" })).toHaveFocus();
    expect(options.onEndRoom).not.toHaveBeenCalled();
  });

  it("offers Create review link with the last created link's copy and the status beside it", async () => {
    const user = userEvent.setup();
    const { options, rerender } = setup({
      lastCreated: {
        token: "sample-review-link",
        url: "http://127.0.0.1:8765/r/sample-review-link",
        kind: "review",
      },
      status: "Review link created and copied",
    });
    const bar = screen
      .getByRole("button", { name: "Create review link" })
      .closest(".dv-share-create") as HTMLElement;
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Create review link", "Copy link"]);
    expect(screen.getByText("Review link created and copied")).toBeVisible();
    await user.click(within(bar).getByRole("button", { name: "Copy link" }));
    expect(options.onCopy).toHaveBeenCalledWith(
      "link",
      "sample-review-link",
      "Link",
      "http://127.0.0.1:8765/r/sample-review-link",
    );

    rerender(
      <ShareSection
        options={{
          ...options,
          lastCreated: { token: "sample-guest-link", url: "u", kind: "guest" },
        }}
      />,
    );
    expect(
      within(bar).getByRole("button", { name: "Copy guest link" }),
    ).toBeInTheDocument();

    rerender(
      <ShareSection
        options={{
          ...options,
          lastCreated: { token: "sample-stale-link", url: "u", kind: "review" },
        }}
      />,
    );
    expect(
      within(bar)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Create review link"]);
  });

  it("shows copied labels", () => {
    const { options, rerender } = setup({
      copiedKey: shareCopyKey("link", "sample-review-link"),
    });
    expect(
      within(reviewItems()[0]).getByRole("button", { name: "Copied" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Copied" })).toHaveLength(1);

    rerender(
      <ShareSection
        options={{
          ...options,
          copiedKey: shareCopyKey("link", "sample-guest-link"),
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copied guest link" }),
    ).toBeInTheDocument();

    rerender(
      <ShareSection
        options={{
          ...options,
          copiedKey: shareCopyKey("mcp", "sample-agent-link"),
        }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copied MCP URL" }),
    ).toBeInTheDocument();
  });

  it("marks a closed record invite and offers source-bound replacement", async () => {
    const user = userEvent.setup();
    const closed = (role: "guest" | "producer") =>
      hostShareRow({
        token: `closed-${role}`,
        kind: "record",
        record_role: role,
        session_id: "sample-room",
        invite_closed: true,
      });
    const { options } = setup({ rows: [closed("guest"), closed("producer")] });
    expect(
      screen.getByText("Guest invite closed to new guests"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Producer invite closed to new producers"),
    ).toBeInTheDocument();
    const copyGuest = screen.getByRole("button", { name: "Copy guest link" });
    expect(copyGuest).toBeDisabled();
    expect(copyGuest).toHaveAttribute(
      "title",
      "This invite is closed. Replace it to share a new link.",
    );
    await user.click(
      screen.getByRole("button", { name: "Replace guest invite" }),
    );
    expect(options.onReplaceRecordInvite).toHaveBeenCalledWith("closed-guest");
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Replace producer invite" }),
    );
    expect(options.onReplaceRecordInvite).toHaveBeenCalledWith(
      "closed-producer",
    );
  });

  it("disables every action while busy, with the reason", () => {
    setup({ busy: true });
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute(
        "title",
        "Wait for the current action to finish.",
      );
    }
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    expect(screen.getByLabelText("Allow AI assistants (MCP)")).toBeDisabled();
    expect(
      screen.getByLabelText("Freeze on the current version"),
    ).toBeDisabled();
  });

  it("shows a missing producer link as disabled", () => {
    setup({ rows: [GUEST_ROW] });
    expect(
      screen.getByText("Missing. End this room and create new record links."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeDisabled();
  });

  it("shows the error over the status in the live region, and the refresh progress", () => {
    const { options, rerender, container } = setup({
      error: "Clipboard unavailable",
      status: "Link copied",
    });
    const live = container.querySelector(".dv-share-feedback") as HTMLElement;
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(within(live).getByText("Clipboard unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();

    rerender(
      <ShareSection
        options={{ ...options, error: null, status: "Link copied" }}
      />,
    );
    expect(screen.getByText("Link copied")).toBeInTheDocument();

    rerender(
      <ShareSection
        options={{
          ...options,
          error: null,
          status: "Link copied",
          createRecovery: { kind: "refreshing" },
        }}
      />,
    );
    expect(live).toHaveTextContent("Refreshing mix preview…");
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();

    rerender(
      <ShareSection
        options={{
          ...options,
          error: null,
          status: null,
          createRecovery: { kind: "retrying" },
        }}
      />,
    );
    expect(live).toHaveTextContent("Mix refreshed. Creating review link…");
  });

  it("moves focus to Create review link once when asked", () => {
    const onFocused = vi.fn();
    const { options, rerender } = setup({ focusRequested: true, onFocused });
    expect(
      screen.getByRole("button", { name: "Create review link" }),
    ).toHaveFocus();
    expect(onFocused).toHaveBeenCalledOnce();
    rerender(
      <ShareSection
        options={{ ...options, focusRequested: true, onFocused }}
      />,
    );
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("makes the role chip icon-only on the phone", () => {
    setup({}, { layout: "phone" });
    expect(
      within(reviewItems()[0]).getByRole("img", { name: /^Commenter/ }),
    ).toBeVisible();
    expect(within(reviewItems()[0]).queryByText("Commenter")).toBeNull();
  });
});
