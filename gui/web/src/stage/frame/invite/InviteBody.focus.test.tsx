import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordHostStore } from "../../../record/hostStore";
import { shareOptionsFixture } from "../../../stages/deliver/shareFixture";
import {
  hostShareRow,
  recordParticipant,
  recordSnapshot,
} from "../../../test/fixtures";
import { cancelInlineConfirm } from "../../../ui/inlineConfirmGate";
import { InviteBody } from "./InviteBody";

const roomRow = () =>
  hostShareRow({
    token: "record-guest",
    kind: "record",
    session_id: "record-session",
    usable: true,
  });

const stageRoom = (fields: Parameters<typeof recordSnapshot>[0] = {}) =>
  act(() =>
    useRecordHostStore.setState({
      endedSessionId: null,
      snapshot: recordSnapshot({
        session_id: "record-session",
        state: "lobby",
        take_index: -1,
        ...fields,
      }),
    }),
  );

beforeEach(() => stageRoom());
afterEach(() =>
  useRecordHostStore.setState({ endedSessionId: null, snapshot: null }),
);

describe("Invite stop focus", () => {
  it.each([
    { role: "commenter" as const, name: "Commenter", group: "Review links" },
    { role: "viewer" as const, name: "listen", group: "Listen link" },
  ])(
    "passes the $group focus target to the stop action",
    async ({ role, name, group }) => {
      const user = userEvent.setup();
      const row = hostShareRow({
        token: "stopped-link",
        docs_role: role,
        follow_latest: role !== "viewer",
      });
      const onStop = vi.fn();
      const options = shareOptionsFixture({ rows: [row], onStop });
      render(<InviteBody options={options} />);
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

  it("passes the Record links focus target to the room end action", async () => {
    const user = userEvent.setup();
    const room = hostShareRow({
      token: "record-guest",
      kind: "record",
      session_id: "record-session",
      usable: true,
    });
    const onEndRoom = vi.fn();
    const options = shareOptionsFixture({
      rows: [room],
      onEndRoom,
    });
    render(<InviteBody options={options} />);
    const heading = screen.getByRole("heading", { name: "Record links" });

    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(onEndRoom).toHaveBeenCalledExactlyOnceWith(
      "record-session",
      expect.any(Function),
    );
    expect(onEndRoom.mock.calls[0]?.[1]()).toBe(heading);
    expect(heading).not.toHaveFocus();
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

describe("Invite End room gate", () => {
  const mount = (onEndRoom = vi.fn()) => {
    render(
      <InviteBody
        options={shareOptionsFixture({ rows: [roomRow()], onEndRoom })}
      />,
    );
    return onEndRoom;
  };

  it("is disabled with a visible reason while a take is running", () => {
    stageRoom({ state: "recording", take_index: 0 });
    mount();
    const end = screen.getByRole("button", { name: "End room" });
    expect(end).toBeDisabled();
    expect(screen.getByText("Stop the take first.")).toBeVisible();
    expect(end).toHaveAccessibleDescription("Stop the take first.");
  });

  it("says the room, not the session, for a take not yet on the timeline", () => {
    stageRoom({ state: "stopped", take_index: 0 });
    mount();
    expect(
      screen.getByText(
        "Wait for every take to reach the timeline before ending the room.",
      ),
    ).toBeVisible();
  });

  it("is disabled with the check-first reason without a snapshot", () => {
    act(() => useRecordHostStore.setState({ snapshot: null }));
    mount();
    expect(screen.getByRole("button", { name: "End room" })).toBeDisabled();
    expect(
      screen.getByText("Open Record to check this room before ending it."),
    ).toBeVisible();
  });

  it("asks first when someone is connected, and Keep room keeps it", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    const onEndRoom = mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(onEndRoom).not.toHaveBeenCalled();
    expect(screen.getByText("End the room? Ava is sent out.")).toBeVisible();
    const keep = screen.getByRole("button", { name: "Keep room" });
    expect(keep).toHaveFocus();
    await user.click(keep);
    expect(onEndRoom).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "End room" })).toHaveFocus();
  });

  it("ends the room from the confirm", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    const onEndRoom = mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(onEndRoom).toHaveBeenCalledExactlyOnceWith(
      "record-session",
      expect.any(Function),
    );
  });

  it("does not end from the confirm once the take has started", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    const onEndRoom = mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    stageRoom({
      state: "recording",
      take_index: 0,
      participants: [recordParticipant({ display_name: "Ava" })],
    });
    expect(screen.queryByRole("button", { name: "Keep room" })).toBeNull();
    expect(screen.getByRole("button", { name: "End room" })).toBeDisabled();
    expect(onEndRoom).not.toHaveBeenCalled();
  });

  it("lets Escape cancel the confirm while busy, with the reason shown", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    const options = shareOptionsFixture({
      rows: [roomRow()],
      onEndRoom: vi.fn(),
    });
    const { rerender } = render(<InviteBody options={options} />);
    await user.click(screen.getByRole("button", { name: "End room" }));
    rerender(<InviteBody options={{ ...options, busy: true }} />);
    expect(screen.getByRole("button", { name: "Keep room" })).toBeDisabled();
    expect(
      screen.getByText("Wait for the current action to finish."),
    ).toBeVisible();
    act(() => {
      expect(cancelInlineConfirm()).toBe(true);
    });
    expect(screen.queryByRole("button", { name: "Keep room" })).toBeNull();
  });

  it("returns focus to End room when the gate blocks while the confirm is open", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    stageRoom({ state: "recording", take_index: 0 });
    expect(screen.queryByRole("button", { name: "Keep room" })).toBeNull();
    stageRoom({ state: "stopped", take_index: 0 });
    stageRoom({ state: "lobby", take_index: -1 });
    expect(screen.getByRole("button", { name: "End room" })).toHaveFocus();
  });

  it("returns focus to End room after a confirmed end while the card stays", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(screen.getByRole("button", { name: "End room" })).toHaveFocus();
  });

  it("describes the confirm's disabled buttons by the visible busy note", async () => {
    const user = userEvent.setup();
    stageRoom({ participants: [recordParticipant({ display_name: "Ava" })] });
    const options = shareOptionsFixture({
      rows: [roomRow()],
      onEndRoom: vi.fn(),
    });
    const { rerender } = render(<InviteBody options={options} />);
    await user.click(screen.getByRole("button", { name: "End room" }));
    rerender(<InviteBody options={{ ...options, busy: true }} />);
    expect(
      screen.getByRole("button", { name: "Keep room" }),
    ).toHaveAccessibleDescription("Wait for the current action to finish.");
  });

  it("acts at once when nobody is connected", async () => {
    const user = userEvent.setup();
    const onEndRoom = mount();
    await user.click(screen.getByRole("button", { name: "End room" }));
    expect(onEndRoom).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Keep room" })).toBeNull();
  });
});
