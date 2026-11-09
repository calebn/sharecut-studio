import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shareOptionsFixture } from "../../../stages/deliver/shareFixture";
import { hostShareRow } from "../../../test/fixtures";
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
      rerender(<InviteBody options={{ ...options, rows: [] }} />);
      await waitFor(() => expect(heading).toHaveFocus());
    },
  );
});
