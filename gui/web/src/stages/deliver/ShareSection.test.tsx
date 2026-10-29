import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../../test/a11y";
import { hostShareRow } from "../../test/fixtures";
import type { TunnelStatus } from "../../types/tunnel";
import { ShareSection } from "./ShareSection";
import { SHARE_DEFAULTS, type ShareOptions } from "./shareLogic";

function options(over: Partial<ShareOptions> = {}): ShareOptions {
  return {
    rows: [],
    loaded: true,
    choices: SHARE_DEFAULTS,
    onChoices: vi.fn(),
    busy: false,
    recovery: { kind: "idle" },
    error: null,
    status: null,
    copiedKey: null,
    blockedKey: null,
    onCreate: vi.fn(),
    onRefreshMix: vi.fn(),
    onCopy: vi.fn(),
    onStop: vi.fn(),
    onCreateRecord: vi.fn(),
    onReplaceInvite: vi.fn(),
    onEndRoom: vi.fn(),
    onOpenRecord: vi.fn(),
    ...over,
  };
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

const review = hostShareRow({ created_at: "2026-09-01T10:00:00Z" });
const agent = hostShareRow({
  token: "sample-agent-link",
  url: "http://127.0.0.1:8765/r/sample-agent-link",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/r/sample-agent-link/mcp",
  follow_latest: false,
  review_version_label: "Rough cut",
});
const guest = hostShareRow({
  token: "sample-guest-link",
  url: "http://127.0.0.1:8765/rec/sample-guest-link",
  kind: "record",
  docs_role: null,
  record_role: "guest",
  session_id: "room-1",
  created_at: "2026-09-01T10:00:00Z",
});
const producer = hostShareRow({
  token: "sample-producer-link",
  url: "http://127.0.0.1:8765/rec/sample-producer-link",
  kind: "record",
  docs_role: null,
  record_role: "producer",
  session_id: "room-1",
});

function tunnel(state: TunnelStatus["state"]): TunnelStatus {
  return {
    state,
    reason: null,
    reason_kind: null,
    relay_host: "relay.example.test",
    public_base_url: "https://share.example.test",
    share_count: 1,
    retry_at: null,
  };
}

describe("ShareSection link choices", () => {
  it("offers Viewer, Commenter and Editor with Commenter chosen, and says what each can do", async () => {
    const user = userEvent.setup();
    const o = options();
    const { container } = render(<ShareSection options={o} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "Share" }),
    ).toBeTruthy();
    expect(button("Commenter").getAttribute("aria-pressed")).toBe("true");
    expect(button("Viewer").getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.getByText(
        "Also comments and suggests edits for you or an Editor to approve.",
      ),
    ).toBeTruthy();
    await user.click(button("Editor"));
    expect(o.onChoices).toHaveBeenLastCalledWith({
      ...SHARE_DEFAULTS,
      role: "editor",
    });
    await expectNoA11yViolations(container);
  });

  it("describes the chosen role", () => {
    render(
      <ShareSection
        options={options({ choices: { ...SHARE_DEFAULTS, role: "viewer" } })}
      />,
    );
    expect(screen.getByText("Views and plays the project.")).toBeTruthy();
  });

  it("reports the MCP and freeze choices, each with its help, and the cursor note", async () => {
    const user = userEvent.setup();
    const o = options();
    render(<ShareSection options={o} />);
    const mcp = button("Allow AI assistants (MCP)");
    const freeze = button("Freeze on the current version");
    expect(mcp.getAttribute("aria-pressed")).toBe("false");
    expect(mcp.getAttribute("aria-describedby")).toBeTruthy();
    await user.click(mcp);
    expect(o.onChoices).toHaveBeenLastCalledWith({
      ...SHARE_DEFAULTS,
      withMcp: true,
    });
    await user.click(freeze);
    expect(o.onChoices).toHaveBeenLastCalledWith({
      ...SHARE_DEFAULTS,
      freeze: true,
    });
    expect(
      document.getElementById(mcp.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toMatch(/Paste into an MCP client/);
    expect(
      document.getElementById(freeze.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toMatch(/Off, the link follows the latest/);
    expect(
      screen.getByText(/sees your cursor, selection, playhead, and viewport/),
    ).toBeTruthy();
  });

  it("shows pressed choices as chosen", () => {
    render(
      <ShareSection
        options={options({
          choices: { role: "editor", withMcp: true, freeze: true },
        })}
      />,
    );
    expect(button("Editor").getAttribute("aria-pressed")).toBe("true");
    expect(
      button("Allow AI assistants (MCP)").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      button("Freeze on the current version").getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("ShareSection Create", () => {
  it("asks for the link from the click on Create review link", async () => {
    const user = userEvent.setup();
    const o = options();
    render(<ShareSection options={o} />);
    await user.click(button("Create review link"));
    expect(o.onCreate).toHaveBeenCalledOnce();
  });

  it("waits while an action runs, and says why", () => {
    render(<ShareSection options={options({ busy: true })} />);
    for (const name of [
      "Create review link",
      "Create record links",
      "Commenter",
      "Allow AI assistants (MCP)",
    ]) {
      expect(button(name)).toBeDisabled();
    }
    expect(button("Create review link").getAttribute("title")).toBe(
      "Wait for the current action to finish.",
    );
  });

  it("shows why Share is unavailable beside the button", () => {
    render(
      <ShareSection
        options={options({ blockedReason: "Open a project first." })}
      />,
    );
    const create = button("Create review link");
    expect(create).toBeDisabled();
    expect(
      document.getElementById(create.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Open a project first.");
    expect(button("Create record links")).toBeDisabled();
  });
});

describe("ShareSection create recovery", () => {
  it("pairs a stale mix with Refresh mix and shows a failed refresh", async () => {
    const user = userEvent.setup();
    const o = options({
      recovery: {
        kind: "needs_refresh",
        message:
          "The mix preview is out of date. Refresh it before creating a review link.",
        refreshError: "Render failed",
      },
    });
    const { container } = render(<ShareSection options={o} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "The mix preview is out of date. Refresh it before creating a review link.",
    );
    expect(screen.getByText("Refresh failed: Render failed")).toBeTruthy();
    await user.click(button("Refresh mix"));
    expect(o.onRefreshMix).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("holds Refresh mix while busy", () => {
    render(
      <ShareSection
        options={options({
          busy: true,
          recovery: {
            kind: "needs_refresh",
            message: "m",
            refreshError: null,
          },
        })}
      />,
    );
    expect(button("Refresh mix")).toBeDisabled();
  });

  it("says Refreshing, then Creating once the mix is back", () => {
    const { rerender } = render(
      <ShareSection options={options({ recovery: { kind: "refreshing" } })} />,
    );
    expect(screen.getByText("Refreshing mix preview…")).toBeTruthy();
    rerender(
      <ShareSection options={options({ recovery: { kind: "retrying" } })} />,
    );
    expect(
      screen.getByText("Mix refreshed. Creating review link…"),
    ).toBeTruthy();
  });

  it("shows an error as an alert and a status as a quiet line, the error first", () => {
    const { rerender } = render(
      <ShareSection options={options({ status: "Review link created" })} />,
    );
    expect(screen.getByText("Review link created")).toBeTruthy();
    rerender(
      <ShareSection
        options={options({ status: "Review link created", error: "Boom" })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Boom");
    expect(screen.queryByText("Review link created")).toBeNull();
  });
});

describe("ShareSection review links", () => {
  it("says there are none, and that the list is still loading before it answers", () => {
    const { rerender } = render(<ShareSection options={options()} />);
    expect(screen.getByText("No review links yet.")).toBeTruthy();
    expect(screen.getByText("No record rooms yet.")).toBeTruthy();
    expect(
      screen.getByText("Links don't expire. Stop sharing turns one off."),
    ).toBeTruthy();
    rerender(<ShareSection options={options({ loaded: false })} />);
    expect(screen.queryByText("No review links yet.")).toBeNull();
    expect(screen.getByText("Looking for your links…")).toBeTruthy();
  });

  it("lists each live link with its role, version, dates, address and MCP", async () => {
    const gone = hostShareRow({
      token: "stopped-link",
      usable: false,
      revoked: true,
    });
    const { container } = render(
      <ShareSection options={options({ rows: [review, agent, gone] })} />,
    );
    const list = screen.getByRole("list", { name: "Review links" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("stopped-link")).toBeNull();
    expect(within(list).getByText("sample-review-link")).toBeTruthy();
    expect(within(list).getByText("sample-agent-link")).toBeTruthy();
    expect(
      within(list).getByText(/Follows latest: Share mix · Created /),
    ).toBeTruthy();
    expect(
      within(list).getByText(/Frozen on Rough cut · AI assistants allowed/),
    ).toBeTruthy();
    expect(within(list).getByRole("img", { name: /^Editor/ })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("copies a link or its MCP URL from the click on its button", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [review, agent] });
    render(<ShareSection options={o} />);
    await user.click(button("Copy Commenter link"));
    expect(o.onCopy).toHaveBeenLastCalledWith(
      "link",
      "sample-review-link",
      "Link",
      review.url,
    );
    await user.click(button("Copy MCP URL"));
    expect(o.onCopy).toHaveBeenLastCalledWith(
      "mcp",
      "sample-agent-link",
      "MCP URL",
      agent.mcp_url,
    );
    expect(
      screen.getAllByRole("button", { name: "Copy MCP URL" }),
    ).toHaveLength(1);
  });

  it("reads Copied on the copied button only", () => {
    render(
      <ShareSection
        options={options({
          rows: [review, agent],
          copiedKey: "mcp:sample-agent-link",
        })}
      />,
    );
    expect(button("Copied MCP URL")).toBeTruthy();
    expect(button("Copy Commenter link")).toBeTruthy();
    expect(button("Copy Editor link")).toBeTruthy();
  });

  it("marks a copy the browser refused, with the link selected for the shortcut", () => {
    render(
      <ShareSection
        options={options({
          rows: [review],
          blockedKey: "link:sample-review-link",
        })}
      />,
    );
    expect(button(/^Press .*C Commenter link$/)).toBeTruthy();
    const text = document.querySelector(".sys-link-text");
    expect(text?.getAttribute("data-selected")).toBe("true");
    expect(window.getSelection()?.toString()).toBe(review.url);
  });

  it("selects the refused link once its row is listed", () => {
    const blocked = options({
      rows: [],
      blockedKey: "link:sample-review-link",
    });
    const view = render(<ShareSection options={blocked} />);
    expect(window.getSelection()?.toString()).toBe("");
    view.rerender(<ShareSection options={{ ...blocked, rows: [review] }} />);
    expect(window.getSelection()?.toString()).toBe(review.url);
  });

  it("disables Copy for a link with no address, with the reason", () => {
    render(
      <ShareSection
        options={options({ rows: [hostShareRow({ url: null })] })}
      />,
    );
    const copy = button("Copy Commenter link");
    expect(copy).toBeDisabled();
    expect(copy.getAttribute("title")).toBe(
      "This link has no address to copy yet.",
    );
  });

  it("holds every row button while an action runs", () => {
    render(<ShareSection options={options({ rows: [agent], busy: true })} />);
    expect(button("Copy Editor link")).toBeDisabled();
    expect(button("Copy MCP URL")).toBeDisabled();
    expect(button("Stop sharing")).toBeDisabled();
  });
});

describe("ShareSection reach and online sharing", () => {
  it("tells people on this network only that the link stays on it", () => {
    render(<ShareSection options={options({ rows: [review] })} />);
    expect(
      screen.getByText(
        "Only people on this network can listen. Turn on online sharing to reach anyone.",
      ),
    ).toBeTruthy();
  });

  it("does not say so when online sharing is on", () => {
    render(
      <ShareSection
        options={options({ rows: [review], tunnel: tunnel("online") })}
      />,
    );
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
  });

  it("does not say so for a link on a public address", () => {
    render(
      <ShareSection
        options={options({
          rows: [hostShareRow({ url: "https://share.example.test/r/a" })],
        })}
      />,
    );
    expect(screen.queryByText(/Only people on this network/)).toBeNull();
  });

  it.each([
    ["online", "Guests can open your links"],
    ["connecting", /^Connecting…/],
    ["reconnecting", /^Reconnecting…/],
    ["offline", /^Not reachable online/],
    ["off", /./],
  ] as const)("shows the %s state of online sharing", (state, headline) => {
    render(<ShareSection options={options({ tunnel: tunnel(state) })} />);
    expect(screen.getByRole("status").textContent).toMatch(headline);
  });

  it("shows nothing about online sharing without a status", () => {
    render(<ShareSection options={options({ tunnel: null })} />);
    expect(document.querySelector(".share-tunnel")).toBeNull();
  });
});

describe("ShareSection Stop sharing", () => {
  it("asks in place, names the role and the consequence, and defaults to Keep link", async () => {
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, "confirm");
    const o = options({ rows: [review] });
    const { container } = render(<ShareSection options={o} />);
    await user.click(button("Stop sharing"));
    expect(o.onStop).not.toHaveBeenCalled();
    const group = screen.getByRole("group", {
      name: "Stop sharing this Commenter link? Anyone using it loses access.",
    });
    expect(
      within(group).getByRole("button", { name: "Keep link" }),
    ).toHaveFocus();
    await expectNoA11yViolations(container);
    await user.click(
      within(group).getByRole("button", { name: "Stop sharing" }),
    );
    expect(o.onStop).toHaveBeenCalledWith("sample-review-link");
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Review links" })).toHaveFocus();
  });

  it("returns focus to Stop sharing on Keep link", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [review] });
    render(<ShareSection options={o} />);
    await user.click(button("Stop sharing"));
    await user.click(button("Keep link"));
    expect(
      screen.queryByRole("group", { name: /Stop sharing this/ }),
    ).toBeNull();
    expect(button("Stop sharing")).toHaveFocus();
    expect(o.onStop).not.toHaveBeenCalled();
  });

  it("keeps the link on Escape", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [review] });
    render(<ShareSection options={o} />);
    await user.click(button("Stop sharing"));
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("group", { name: /Stop sharing this/ }),
    ).toBeNull();
    expect(button("Stop sharing")).toHaveFocus();
    expect(o.onStop).not.toHaveBeenCalled();
  });

  it("confirms for one link at a time and leaves the others alone", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [review, agent] });
    render(<ShareSection options={o} />);
    await user.click(
      screen.getAllByRole("button", { name: "Stop sharing" })[1],
    );
    expect(
      screen.getByRole("group", {
        name: "Stop sharing this Editor link? Anyone using it loses access.",
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Stop sharing" }),
    ).toHaveLength(2);
    await user.click(
      within(
        screen.getByRole("group", { name: /Stop sharing this/ }),
      ).getByRole("button", {
        name: "Stop sharing",
      }),
    );
    expect(o.onStop).toHaveBeenCalledWith("sample-agent-link");
  });

  it("does not stop a link while an action runs", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [review] });
    const { rerender } = render(<ShareSection options={o} />);
    await user.click(button("Stop sharing"));
    rerender(<ShareSection options={{ ...o, busy: true }} />);
    const group = screen.getByRole("group", { name: /Stop sharing this/ });
    expect(
      within(group).getByRole("button", { name: "Stop sharing" }),
    ).toBeDisabled();
  });
});

describe("ShareSection record rooms", () => {
  it("creates record links from the click", async () => {
    const user = userEvent.setup();
    const o = options();
    render(<ShareSection options={o} />);
    await user.click(button("Create record links"));
    expect(o.onCreateRecord).toHaveBeenCalledOnce();
  });

  it("lists a room with its guest and producer links and copies each", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [guest, producer] });
    const { container } = render(<ShareSection options={o} />);
    const rooms = screen.getByRole("list", { name: "Record rooms" });
    expect(within(rooms).getAllByRole("listitem")).toHaveLength(1);
    expect(within(rooms).getByText("Guest link")).toBeTruthy();
    expect(within(rooms).getByText("Producer link")).toBeTruthy();
    expect(within(rooms).getByText("sample-guest-link")).toBeTruthy();
    await user.click(button("Copy guest link"));
    expect(o.onCopy).toHaveBeenLastCalledWith(
      "link",
      "sample-guest-link",
      "Guest link",
      guest.url,
    );
    await user.click(button("Copy producer link"));
    expect(o.onCopy).toHaveBeenLastCalledWith(
      "link",
      "sample-producer-link",
      "Producer link",
      producer.url,
    );
    await expectNoA11yViolations(container);
  });

  it("flashes Copied on the guest link", () => {
    render(
      <ShareSection
        options={options({
          rows: [guest, producer],
          copiedKey: "link:sample-guest-link",
        })}
      />,
    );
    expect(button("Copied guest link")).toBeTruthy();
    expect(button("Copy producer link")).toBeTruthy();
  });

  it("shows a closed invite, will not copy it, and replaces it", async () => {
    const user = userEvent.setup();
    const closed = { ...guest, invite_closed: true };
    const o = options({ rows: [closed, producer] });
    render(<ShareSection options={o} />);
    expect(screen.getByText("Guest invite closed to new guests")).toBeTruthy();
    expect(button("Copy guest link")).toBeDisabled();
    expect(button("Copy guest link").getAttribute("title")).toBe(
      "This invite is closed. Replace it to share a new link.",
    );
    expect(
      screen.queryByRole("button", { name: "Replace producer invite" }),
    ).toBeNull();
    await user.click(button("Replace guest invite"));
    expect(o.onReplaceInvite).toHaveBeenCalledWith("sample-guest-link");
  });

  it("names a producer link that is missing", () => {
    render(<ShareSection options={options({ rows: [guest] })} />);
    expect(
      screen.getByText("Missing. End this room and create new record links."),
    ).toBeTruthy();
    expect(button("Copy producer link")).toBeDisabled();
  });

  it("opens the Record stage from a live room", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [guest, producer] });
    render(<ShareSection options={o} />);
    await user.click(button("Open Record stage"));
    expect(o.onOpenRecord).toHaveBeenCalledOnce();
  });

  it("ends a room only after the in-place confirm, with Keep room as the default", async () => {
    const user = userEvent.setup();
    const o = options({ rows: [guest, producer] });
    render(<ShareSection options={o} />);
    await user.click(button("End room"));
    expect(o.onEndRoom).not.toHaveBeenCalled();
    const group = screen.getByRole("group", {
      name: "End this record room? Both guest and producer links will stop working.",
    });
    expect(
      within(group).getByRole("button", { name: "Keep room" }),
    ).toHaveFocus();
    await user.click(within(group).getByRole("button", { name: "Keep room" }));
    expect(button("End room")).toHaveFocus();
    await user.click(button("End room"));
    await user.click(
      within(
        screen.getByRole("group", { name: /End this record room/ }),
      ).getByRole("button", {
        name: "End room",
      }),
    );
    expect(o.onEndRoom).toHaveBeenCalledWith("room-1");
    expect(screen.getByRole("heading", { name: "Record rooms" })).toHaveFocus();
  });
});

describe("ShareSection focus and loading", () => {
  it("focuses Create review link when asked, then says it did", () => {
    const onFocused = vi.fn();
    render(
      <ShareSection options={options({ focusRequested: true, onFocused })} />,
    );
    expect(button("Create review link")).toHaveFocus();
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("lands on the first enabled control when Create is unavailable", () => {
    const onFocused = vi.fn();
    render(
      <ShareSection
        options={options({
          focusRequested: true,
          onFocused,
          blockedReason: "Open a project first.",
        })}
      />,
    );
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement).not.toBeDisabled();
    expect(onFocused).toHaveBeenCalledOnce();
  });

  it("shows a skeleton while the page loads", () => {
    render(<ShareSection options={options()} state="loading" />);
    expect(screen.getByRole("heading", { name: "Share" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Create review link" }),
    ).toBeNull();
  });
});
