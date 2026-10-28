import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { GuestCovers } from "./GuestCovers";
import { guestCoverProps } from "./guestRoomModel";

const host = recordParticipant({
  participant_id: "p_host",
  role: "host",
  display_name: "Hana",
});

function room(over: Partial<Parameters<typeof guestCoverProps>[0]> = {}) {
  return {
    bootError: null,
    error: null,
    accessEnded: false,
    inviteClosed: false,
    captureSettled: true,
    localRecording: true,
    keeperActions: { busy: false, error: null, notice: null },
    snapshot: recordSnapshot({ participants: [host] }),
    ...over,
  };
}

function show(over: Partial<Parameters<typeof guestCoverProps>[0]> = {}) {
  const onRetry = vi.fn();
  const cover = guestCoverProps(room(over), onRetry);
  if (!cover) {
    throw new Error("no cover");
  }
  const { error, notice } = over.keeperActions ?? {};
  const view = render(<GuestCovers cover={cover} status={error ?? notice} />);
  return { ...view, onRetry };
}

describe("GuestCovers", () => {
  it("has no cover for a healthy room", () => {
    expect(guestCoverProps(room(), vi.fn())).toBeNull();
  });

  it("covers an invalid link in the page's main", async () => {
    const { container } = show({ bootError: "HTTP 404" });
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "This link doesn't open a room" }),
    );
    await expectNoA11yViolations(container);
  });

  it("covers a full room and Try again hands back to the caller", async () => {
    const { onRetry, container } = show({ error: "room_full" });
    expect(
      screen.getByText("Ask Hana to make space or send you a new link."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("covers a closed invite with the host's name", () => {
    show({ accessEnded: true, inviteClosed: true });
    expect(
      screen.getByRole("heading", { name: "Invite link closed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Hana closed this invite link. Ask for a new link."),
    ).toBeInTheDocument();
  });

  it("covers ended access, and waits for the capture to settle", () => {
    const { unmount } = show({ accessEnded: true, captureSettled: false });
    expect(
      screen.getByText("Finishing your full-quality recording…"),
    ).toBeInTheDocument();
    unmount();
    show({ accessEnded: true });
    expect(screen.getByText("Thanks for recording.")).toBeInTheDocument();
  });

  describe("with a recording on this device", () => {
    const take = {
      snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
    };

    it("saves it with the primary and retries with the secondary", async () => {
      const download = vi.fn();
      const recover = vi.fn();
      const { container } = show({
        ...take,
        accessEnded: true,
        keeperActions: {
          busy: false,
          error: null,
          notice: null,
          download,
          recover,
        },
      });
      expect(
        screen.getByRole("heading", {
          name: "Your recording didn't finish saving",
        }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Save my recording" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Try saving again" }),
      );
      expect(download).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledOnce();
      await expectNoA11yViolations(container);
    });

    it("keeps Save and Recover when the invite link closes", async () => {
      const download = vi.fn();
      const recover = vi.fn();
      const { container } = show({
        ...take,
        accessEnded: true,
        inviteClosed: true,
        keeperActions: {
          busy: false,
          error: null,
          notice: "Recovered 1 partial segment.",
          download,
          recover,
        },
      });
      expect(
        screen.getByRole("heading", { name: "Invite link closed" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/safe on this device/)).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Save my recording" }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Try saving again" }),
      );
      expect(download).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recovered 1 partial segment.",
      );
      await expectNoA11yViolations(container);
    });

    it("holds the primary while an action runs and says how it went", () => {
      show({
        ...take,
        accessEnded: true,
        keeperActions: {
          busy: true,
          error: "locked by another tab",
          notice: "ignored",
          download: vi.fn(),
        },
      });
      const save = screen.getByRole("button", { name: "Save my recording" });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("status")).toHaveTextContent(
        "locked by another tab",
      );
    });

    it("shows the notice when there is no error", () => {
      show({
        ...take,
        accessEnded: true,
        keeperActions: {
          busy: false,
          error: null,
          notice: "Recovered 1 partial segment.",
          recover: vi.fn(),
        },
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Recovered 1 partial segment.",
      );
    });
  });

  it("offers no recording actions on a closed invite with nothing local", () => {
    show({ accessEnded: true, inviteClosed: true });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(
      screen.getByText("Hana closed this invite link. Ask for a new link."),
    ).toBeInTheDocument();
  });

  it("offers no recording actions on a closed invite before the first take", () => {
    show({
      accessEnded: true,
      inviteClosed: true,
      keeperActions: {
        busy: false,
        error: null,
        notice: null,
        download: vi.fn(),
        recover: vi.fn(),
      },
      snapshot: recordSnapshot({ participants: [host], take_index: -1 }),
    });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers no recording actions once nothing is left on this device", () => {
    const actions = {
      busy: false,
      error: null,
      notice: null,
      download: vi.fn(),
      recover: vi.fn(),
    };
    const take = {
      snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
      keeperActions: actions,
      localRecording: false,
    };
    const ended = show({ ...take, accessEnded: true });
    expect(screen.getByText("Thanks for recording.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    ended.unmount();
    show({ ...take, accessEnded: true, inviteClosed: true });
    expect(
      screen.getByText("Hana closed this invite link. Ask for a new link."),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers no recording actions before the first take", () => {
    show({
      accessEnded: true,
      keeperActions: {
        busy: false,
        error: null,
        notice: null,
        download: vi.fn(),
        recover: vi.fn(),
      },
      snapshot: recordSnapshot({ participants: [host], take_index: -1 }),
    });
    expect(
      screen.queryByRole("button", { name: "Save my recording" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "This session has ended" }),
    ).toBeInTheDocument();
  });
});
