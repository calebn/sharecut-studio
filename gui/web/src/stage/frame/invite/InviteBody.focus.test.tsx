import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shareOptionsFixture } from "../../../stages/deliver/shareFixture";
import { hostShareRow } from "../../../test/fixtures";
import { InviteBody } from "./InviteBody";

describe("Invite stop focus", () => {
  it.each([
    { role: "commenter" as const, name: "Commenter", group: "Review links" },
    { role: "viewer" as const, name: "listen", group: "Listen link" },
  ])(
    "focuses $group only after its stopped row disappears",
    async ({ role, name, group }) => {
      const user = userEvent.setup();
      const row = hostShareRow({
        token: "stopped-link",
        docs_role: role,
        follow_latest: role !== "viewer",
      });
      const onStop = vi.fn();
      const options = shareOptionsFixture({ rows: [row], onStop });
      const { rerender } = render(<InviteBody options={options} />);
      const heading = screen.getByRole("heading", { name: group });
      await user.click(
        screen.getByRole("button", { name: `More for ${name} link` }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
      expect(onStop).toHaveBeenCalledExactlyOnceWith(
        "stopped-link",
        expect.any(Function),
      );
      expect(onStop.mock.calls[0]?.[1]()).toBe(heading);
      expect(heading).not.toHaveFocus();
      expect(
        screen.getByRole("button", { name: `More for ${name} link` }),
      ).toBeVisible();
      const unrelated = hostShareRow({
        token: "unrelated-link",
        docs_role: "commenter",
      });
      rerender(<InviteBody options={{ ...options, rows: [row, unrelated] }} />);
      expect(heading).not.toHaveFocus();
      rerender(<InviteBody options={{ ...options, rows: [] }} />);
      await waitFor(() => expect(heading).toHaveFocus());
      const copyButton = screen.getByRole("button", {
        name: "Copy new Commenter link",
      });
      copyButton.focus();
      rerender(<InviteBody options={{ ...options, rows: [unrelated] }} />);
      expect(copyButton).toHaveFocus();
    },
  );

  it("does not focus Listen while the stopped target remains after a failed stop", async () => {
    const user = userEvent.setup();
    const row = hostShareRow({
      token: "retained-listen-link",
      docs_role: "viewer",
      follow_latest: false,
    });
    const options = shareOptionsFixture({ rows: [row], onStop: vi.fn() });
    const { rerender } = render(<InviteBody options={options} />);
    const heading = screen.getByRole("heading", { name: "Listen link" });

    await user.click(
      screen.getByRole("button", { name: "More for listen link" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
    rerender(<InviteBody options={{ ...options, error: "Stop failed" }} />);

    expect(heading).not.toHaveFocus();
    expect(screen.getByText("Stop failed")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More for listen link" }),
    ).toBeVisible();
  });

  it("focuses Record when the ended session disappears", async () => {
    const user = userEvent.setup();
    const room = hostShareRow({
      token: "record-guest",
      kind: "record",
      session_id: "record-session",
      usable: true,
    });
    const replacement = hostShareRow({
      token: "other-record-guest",
      kind: "record",
      session_id: "other-session",
      usable: true,
    });
    const options = shareOptionsFixture({
      rows: [room],
      onEndRoom: vi.fn(),
    });
    const { rerender } = render(<InviteBody options={options} />);
    const heading = screen.getByRole("heading", { name: "Record links" });

    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(options.onEndRoom).toHaveBeenCalledExactlyOnceWith(
      "record-session",
      expect.any(Function),
    );
    expect(heading).not.toHaveFocus();
    rerender(<InviteBody options={{ ...options, rows: [replacement] }} />);
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("does not move focus for an ignored stop", async () => {
    const user = userEvent.setup();
    const row = hostShareRow({ token: "kept-link", docs_role: "commenter" });
    const options = shareOptionsFixture({
      rows: [row],
      onStop: vi.fn(() => false),
    });
    const { rerender } = render(<InviteBody options={options} />);
    const heading = screen.getByRole("heading", { name: "Review links" });
    await user.click(
      screen.getByRole("button", { name: "More for Commenter link" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
    rerender(<InviteBody options={{ ...options, rows: [] }} />);
    expect(heading).not.toHaveFocus();
  });
});
