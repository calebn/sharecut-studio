import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import type { HostShareRow } from "../types/shares";
import { ShareDialog } from "./ShareDialog";

const listHostShares = vi.fn();
const createHostShare = vi.fn();
const revokeHostShare = vi.fn();
const createHostRecordRoom = vi.fn();
const revokeHostRoom = vi.fn();

vi.mock("../api", () => ({
  listHostShares: (...args: unknown[]) => listHostShares(...args),
  createHostShare: (...args: unknown[]) => createHostShare(...args),
  revokeHostShare: (...args: unknown[]) => revokeHostShare(...args),
  createHostRecordRoom: (...args: unknown[]) => createHostRecordRoom(...args),
  revokeHostRoom: (...args: unknown[]) => revokeHostRoom(...args),
}));

const projectStub = {
  name: "ep",
  timeline_duration_sec: 60,
  tracks: [],
  clips: { tracks: {} },
} as never;

const liveRow: HostShareRow = {
  token: "fantastic-acoustic-whale",
  url: "http://127.0.0.1:8765/r/fantastic-acoustic-whale",
  docs_role: "commenter",
  mcp_url: null,
  usable: true,
  review_version_label: "Share mix",
  last_used_at: "2026-09-05T12:00:00Z",
};

const mcpRow: HostShareRow = {
  ...liveRow,
  token: "editor-mcp-narwhal",
  url: "http://127.0.0.1:8765/r/editor-mcp-narwhal",
  docs_role: "editor",
  mcp_url: "http://127.0.0.1:8765/mcp/editor-mcp-narwhal/mcp",
};

function listed(shares: HostShareRow[] = []) {
  return {
    shares,
    public_origin: "http://127.0.0.1:8765",
  };
}

describe("ShareDialog", () => {
  beforeEach(() => {
    listHostShares.mockReset();
    createHostShare.mockReset();
    revokeHostShare.mockReset();
    createHostRecordRoom.mockReset();
    revokeHostRoom.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    listHostShares.mockResolvedValue(listed());
    useDawStore.setState({
      shareDialogOpen: false,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      statusAnnouncement: "",
    });
  });

  it("shows empty live list and is axe-clean", async () => {
    useDawStore.setState({ shareDialogOpen: true });
    const { container } = render(<ShareDialog />);
    const dialog = await screen.findByRole("dialog", { name: "Share" });
    expect(dialog.querySelector(".command-palette-body")).toBeTruthy();
    expect(dialog.querySelector(".share-dialog-body")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Record rooms" }),
    ).toBeTruthy();
    expect(await screen.findByText("No live review links.")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("creates a link, copies it, and lists the live row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await screen.findByText("No live review links.");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => {
      expect(createHostShare).toHaveBeenCalledWith("/tmp/ep.project.json", {
        role: "commenter",
        with_mcp: false,
      });
    });
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(screen.getByText(/Commenter · Share mix/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(liveRow.url);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Share link created/,
    );
  });

  it("keeps Create link label and reports clipboard errors after mint", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi
          .fn()
          .mockRejectedValue(new Error("Clipboard unavailable")),
      },
    });
    createHostShare.mockResolvedValue(liveRow);
    listHostShares
      .mockResolvedValueOnce(listed())
      .mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await screen.findByText("No live review links.");
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Clipboard unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Share link created",
    );
  });

  it("flashes Copied on the copy button after Copy link", async () => {
    const user = userEvent.setup();
    listHostShares.mockResolvedValue(listed([liveRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    await user.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("Link copied");
  });

  it("copies the agent URL for MCP shares", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listHostShares.mockResolvedValue(listed([mcpRow]));
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy agent URL" }),
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mcpRow.mcp_url);
    });
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe("Agent URL copied");
  });

  it("lists live rows and is axe-clean", async () => {
    listHostShares.mockResolvedValue(listed([liveRow, mcpRow]));
    useDawStore.setState({ shareDialogOpen: true });
    const { container } = render(<ShareDialog />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    expect(await screen.findByText("editor-mcp-narwhal")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy agent URL" })).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("revokes a live share after confirm", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    listHostShares.mockResolvedValue(listed([liveRow]));
    revokeHostShare.mockResolvedValue(undefined);
    useDawStore.setState({ shareDialogOpen: true });
    render(<ShareDialog />);
    expect(await screen.findByText("fantastic-acoustic-whale")).toBeTruthy();
    listHostShares.mockResolvedValue(
      listed([{ ...liveRow, usable: false, revoked: true }]),
    );
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => {
      expect(revokeHostShare).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "fantastic-acoustic-whale",
      );
    });
    expect(await screen.findByText("No live review links.")).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button" data-testid="opener">
          Open share
        </button>
        <div data-daw-app-chrome />
        <ShareDialog />
      </div>,
    );
    screen.getByTestId("opener").focus();
    useDawStore.setState({ shareDialogOpen: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(useDawStore.getState().shareDialogOpen).toBe(false);
  });

  it("creates record links and can end the room", async () => {
    const guestRow: HostShareRow = {
      token: "guest-room-tok",
      url: "http://127.0.0.1:8765/rec/guest-room-tok",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
    };
    const producerRow: HostShareRow = {
      ...guestRow,
      token: "prod-room-tok",
      url: "http://127.0.0.1:8765/rec/prod-room-tok",
      record_role: "producer",
    };
    let shares: HostShareRow[] = [];
    listHostShares.mockImplementation(async () => listed(shares));
    createHostRecordRoom.mockImplementation(async () => {
      shares = [guestRow, producerRow];
      return {
        session_id: "sess1",
        guest: guestRow,
        producer: producerRow,
      };
    });
    revokeHostRoom.mockImplementation(async () => {
      shares = [];
      return {
        session_id: "sess1",
        revoked: [guestRow.token, producerRow.token],
      };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useDawStore.setState({ shareDialogOpen: true });
    const { container } = render(<ShareDialog />);
    await screen.findByRole("heading", { name: "Record session" });
    fireEvent.click(
      screen.getByRole("button", { name: "Create record links" }),
    );
    await waitFor(() => {
      expect(createHostRecordRoom).toHaveBeenCalledWith("/tmp/ep.project.json");
    });
    expect(await screen.findByText("Guest link")).toBeTruthy();
    expect(screen.getByText("Producer link")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Copied guest link" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy producer link" }),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "End room" }),
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "End room" }));
    await waitFor(() => {
      expect(revokeHostRoom).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        "sess1",
      );
    });
    expect(await screen.findByText("No live record rooms.")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("opens the record panel from a live room", async () => {
    const { registerDawCommands } = await import("../commands/register");
    registerDawCommands();
    const guestRow: HostShareRow = {
      token: "guest-room-tok",
      url: "http://127.0.0.1:8765/rec/guest-room-tok",
      kind: "record",
      docs_role: null,
      record_role: "guest",
      session_id: "sess1",
      mcp_url: null,
      usable: true,
    };
    const producerRow: HostShareRow = {
      ...guestRow,
      token: "prod-room-tok",
      url: "http://127.0.0.1:8765/rec/prod-room-tok",
      record_role: "producer",
    };
    listHostShares.mockResolvedValue(listed([guestRow, producerRow]));
    useDawStore.setState({ shareDialogOpen: true, recordPanelOpen: false });
    render(<ShareDialog />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open room panel" }),
    );
    expect(useDawStore.getState().shareDialogOpen).toBe(false);
    expect(useDawStore.getState().recordPanelOpen).toBe(true);
  });
});
