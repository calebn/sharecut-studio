import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shareOptionsFixture } from "../../../stages/deliver/shareFixture";
import { hostShareRow } from "../../../test/fixtures";
import { InviteSheetView } from "../InviteSheet";
import { InviteBody } from "./InviteBody";

describe("Invite confirmed-stop focus", () => {
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
      const confirm = screen.getByRole("group", {
        name: `Stop sharing this ${role === "viewer" ? "Viewer" : "Commenter"} link? Anyone using it loses access.`,
      });
      within(confirm).getByRole("button", { name: "Stop sharing" }).focus();
      await user.keyboard("{Enter}");
      expect(onStop).toHaveBeenCalledExactlyOnceWith("stopped-link");
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

  it("keeps the Listen row and does not focus a heading when Keep is chosen", async () => {
    const user = userEvent.setup();
    const row = hostShareRow({
      token: "kept-listen-link",
      docs_role: "viewer",
      follow_latest: false,
    });
    const onStop = vi.fn();
    const onClose = vi.fn();
    render(
      <InviteSheetView
        options={shareOptionsFixture({ rows: [row], onStop })}
        form="centered"
        open
        onClose={onClose}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "More for listen link" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
    await user.click(screen.getByRole("button", { name: "Keep link" }));

    expect(onStop).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Listen link" }),
    ).not.toHaveFocus();
    expect(
      screen.getByRole("button", { name: "More for listen link" }),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Invite" })).toBeVisible();
  });

  it("does not focus Listen while the confirmed target remains after a failed stop", async () => {
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
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    rerender(<InviteBody options={{ ...options, error: "Stop failed" }} />);

    expect(heading).not.toHaveFocus();
    expect(screen.getByText("Stop failed")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "More for listen link" }),
    ).toBeVisible();
  });

  it("focuses Record when the confirmed session disappears", async () => {
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
    const options = shareOptionsFixture({ rows: [room] });
    const { rerender } = render(<InviteBody options={options} />);
    const heading = screen.getByRole("heading", { name: "Record links" });

    await user.click(screen.getByRole("button", { name: "End room" }));
    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(heading).not.toHaveFocus();
    rerender(<InviteBody options={{ ...options, rows: [replacement] }} />);
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("lets the Invite sheet keep an open Listen confirmation on Escape", async () => {
    const user = userEvent.setup();
    const row = hostShareRow({
      token: "escaped-listen-link",
      docs_role: "viewer",
      follow_latest: false,
    });
    const onStop = vi.fn();
    const onClose = vi.fn();
    render(
      <InviteSheetView
        options={shareOptionsFixture({ rows: [row], onStop })}
        form="centered"
        open
        onClose={onClose}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "More for listen link" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Stop sharing" }));
    await user.keyboard("{Escape}");

    expect(
      screen.getByRole("button", { name: "More for listen link" }),
    ).toBeVisible();
    expect(onStop).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Invite" })).toBeVisible();
  });
});
