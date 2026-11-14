import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import type { RoomPhase } from "../system/roomPhase";
import { expectNoA11yViolations } from "../test/a11y";
import { recordParticipant, recordSnapshot } from "../test/fixtures";
import { GuestCovers } from "./GuestCovers";
import { guestCoverProps } from "./guestRoomModel";
import { guestTabTitle } from "./guestTabTitle";
import { MemorySink } from "./keeper/store";
import * as recovery from "./upload/recovery";
import { useKeeperRecoveryActions } from "./upload/useKeeperRecoveryActions";

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
    left: false,
    captureSettled: true,
    localRecording: true,
    producer: false,
    upload: { fileAck: false },
    keeperActions: {
      busy: false,
      error: null,
      notice: null,
      downloaded: false,
    },
    snapshot: recordSnapshot({ participants: [host] }),
    ...over,
  };
}

const waiting = { kind: "waiting" } as const;

function show(
  over: Partial<Parameters<typeof guestCoverProps>[0]> = {},
  options: { phase?: RoomPhase } = {},
) {
  const onRetry = vi.fn();
  const cover = guestCoverProps(room(over), {
    onRetry,
    phase: options.phase ?? waiting,
  });
  if (!cover) {
    throw new Error("no cover");
  }
  const { error, notice } = over.keeperActions ?? {};
  const view = render(<GuestCovers cover={cover} status={error ?? notice} />);
  return { ...view, onRetry };
}

describe("GuestCovers", () => {
  it("has no cover for a healthy room", () => {
    expect(
      guestCoverProps(room(), {
        onRetry: vi.fn(),
        phase: waiting,
      }),
    ).toBeNull();
  });

  it("covers an invalid link in the page's main", async () => {
    const { container } = show({ bootError: "not-found" });
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

  it("covers a guest who left, and Join again hands back to the caller", async () => {
    const { onRetry, container } = show({ left: true });
    expect(
      screen.getByRole("heading", { name: "You left the room" }),
    ).toBeInTheDocument();
    expect(screen.getByText("You can close this page.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Join again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("tells a guest who left after Saved that the recording is in the host's project", () => {
    show({ left: true }, { phase: { kind: "saved" } });
    expect(
      screen.getByText(
        "Your recording is saved to Hana's project. You can close this page.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing of a recording to a producer", () => {
    show({ left: true, producer: true }, { phase: { kind: "saved" } });
    expect(screen.getByText("You can close this page.")).toBeInTheDocument();
  });

  it("keeps an unsent local copy reachable after leaving a stopped save", async () => {
    const download = vi.fn();
    show(
      {
        left: true,
        snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
        keeperActions: { busy: false, error: null, notice: null, download },
      },
      {
        phase: {
          kind: "saving",
          savedPeople: 0,
          totalPeople: 1,
          failed: true,
        },
      },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save my recording" }),
    );
    expect(download).toHaveBeenCalledOnce();
  });

  it("keeps the unsent copy reachable whatever consent says after Stop", async () => {
    const download = vi.fn();
    show(
      {
        left: true,
        snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
        keeperActions: { busy: false, error: null, notice: null, download },
      },
      {
        phase: { kind: "saving", savedPeople: 0, totalPeople: 1, failed: true },
      },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save my recording" }),
    );
    expect(download).toHaveBeenCalledOnce();
  });

  it("tells a saved guest it is saved while the local copy waits to be reclaimed", () => {
    show(
      {
        left: true,
        snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
        keeperActions: {
          busy: false,
          error: null,
          notice: null,
          download: vi.fn(),
          recover: vi.fn(),
        },
      },
      { phase: { kind: "saved" } },
    );
    expect(
      screen.getByText(
        "Your recording is saved to Hana's project. You can close this page.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save my recording" }),
    ).toBeNull();
  });

  it("does not say the page can close while capture is still finishing", () => {
    show(
      { left: true, captureSettled: false },
      {
        phase: { kind: "saving", savedPeople: 0, totalPeople: 1, failed: true },
      },
    );
    expect(
      screen.getByText("Finishing your full-quality recording…"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/close this page/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Join again" })).toBeNull();
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
          downloaded: false,
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
          downloaded: false,
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
          downloaded: false,
          error: "locked by another tab",
          notice: "ignored",
          download: vi.fn(),
        },
      });
      const save = screen.getByRole("button", { name: "Saving…" });
      expect(save).toHaveAttribute("aria-disabled", "true");
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
          downloaded: false,
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
        downloaded: false,
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
      downloaded: false,
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

  it("offers no recording actions for a recording the server acknowledged", () => {
    show({
      accessEnded: true,
      upload: { fileAck: true },
      snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
      keeperActions: {
        busy: false,
        downloaded: false,
        error: null,
        notice: null,
        download: vi.fn(),
        recover: vi.fn(),
      },
    });
    expect(screen.getByText("Thanks for recording.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers no recording actions before the first take", () => {
    show({
      accessEnded: true,
      keeperActions: {
        busy: false,
        downloaded: false,
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

describe("GuestCovers headings and boot failures", () => {
  it.each([
    [{ bootError: "not-found" as const }, "This link doesn't open a room"],
    [{ bootError: "network" as const }, "Couldn't reach the room"],
    [{ bootError: "server" as const }, "The room didn't answer"],
    [{ error: "room_full" }, "The room is full"],
    [{ accessEnded: true }, "This session has ended"],
  ])("gives every guest cover one level-one heading (%o)", (over, title) => {
    show(over);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(title);
  });

  it("covers a network failure with Try again and no raw text", async () => {
    const { onRetry, container } = show({ bootError: "network" });
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Couldn't reach the room",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Check your internet connection, then try again. If it keeps happening, let the person who invited you know.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /Failed to fetch|network_error|Couldn't reach the server/,
      ),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });

  it("asks again once when the browser comes back online", () => {
    const onOnline = vi.fn();
    const cover = guestCoverProps(room({ bootError: "network" }), {
      onRetry: vi.fn(),
      phase: waiting,
    });
    if (!cover) {
      throw new Error("no cover");
    }
    render(<GuestCovers cover={cover} onOnline={onOnline} />);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    expect(onOnline).toHaveBeenCalledOnce();
  });
});

describe("after Save my recording handed the whole zip to the browser", () => {
  afterEach(() => vi.restoreAllMocks());

  function Ended({ takeIndex = 0 }: { takeIndex?: number }) {
    const keeperActions = useKeeperRecoveryActions({
      sink: new MemorySink(),
      sessionId: "room1",
      participantId: "p_g",
      takeIndex,
      recoverAllowed: true,
      onRecovered: () => undefined,
    });
    const cover = guestCoverProps(
      room({
        accessEnded: true,
        keeperActions,
        snapshot: recordSnapshot({
          participants: [host],
          take_index: takeIndex,
        }),
      }),
      { onRetry: vi.fn(), phase: waiting },
    );
    useDocumentTitle(
      guestTabTitle({
        cover,
        bootstrapped: true,
        seat: "guest",
        stance: "in",
        phase: { kind: "waiting" },
        episode: "Shot of Truth",
      }),
    );
    return cover ? (
      <GuestCovers
        cover={cover}
        status={keeperActions.error ?? keeperActions.notice}
      />
    ) : null;
  }

  it("keeps the cover, the heading, the tab title and focus while Save it again runs, and falls back only if it fails", async () => {
    const download = vi
      .spyOn(recovery, "downloadLocalKeepers")
      .mockResolvedValueOnce(undefined);
    render(<Ended />);
    await userEvent.click(
      screen.getByRole("button", { name: "Save my recording" }),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Check your downloads",
      }),
    ).toBeInTheDocument();

    let fail: (reason: Error) => void = () => undefined;
    download.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const again = screen.getByRole("button", { name: "Save it again" });
    await userEvent.click(again);

    expect(
      screen.getByRole("heading", { level: 1, name: "Check your downloads" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Check your downloads | Shot of Truth");
    const stillThere = screen.getByRole("button", { name: "Saving…" });
    expect(stillThere).toBe(again);
    expect(stillThere).toHaveAttribute("aria-busy", "true");
    expect(stillThere).toHaveFocus();

    await act(async () => fail(new Error("Disk full.")));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Your recording didn't finish saving",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Disk full.");
  });

  it("says Saving… on Save my recording while the first download runs, then offers Save it again", async () => {
    let finish: () => void = () => undefined;
    vi.spyOn(recovery, "downloadLocalKeepers").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<Ended />);
    const save = screen.getByRole("button", { name: "Save my recording" });
    await userEvent.click(save);
    expect(screen.getByRole("button", { name: "Saving…" })).toBe(save);
    await act(async () => finish());
    expect(
      await screen.findByRole("button", { name: "Save it again" }),
    ).toBeInTheDocument();
  });

  it("is not shown while the saved recording's local copy is still held", () => {
    const cover = guestCoverProps(
      room({
        accessEnded: true,
        localRecording: true,
        upload: { fileAck: true },
        keeperActions: {
          busy: false,
          error: null,
          notice: null,
          downloaded: true,
          download: vi.fn(),
          recover: vi.fn(),
        },
        snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
      }),
      { onRetry: vi.fn(), phase: waiting },
    );
    expect(cover?.title).toBe("This session has ended");
    expect(cover?.children).toBe("Thanks for recording.");
    expect(cover?.primary).toBeUndefined();
    expect(cover?.secondary).toBeUndefined();
  });

  it("is not shown once the recording has since been saved to the project", () => {
    const cover = guestCoverProps(
      room({
        accessEnded: true,
        localRecording: false,
        keeperActions: {
          busy: false,
          error: null,
          notice: null,
          downloaded: true,
        },
        snapshot: recordSnapshot({ participants: [host], take_index: 0 }),
      }),
      { onRetry: vi.fn(), phase: waiting },
    );
    expect(cover?.title).toBe("This session has ended");
  });
});
