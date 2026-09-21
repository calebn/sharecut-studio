import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordingCloseMessage,
  useDesktopCloseGuard,
} from "./useDesktopCloseGuard";

const { onCloseRequested, destroy, isTauri, getCurrentWindow } = vi.hoisted(
  () => ({
    onCloseRequested: vi.fn(),
    destroy: vi.fn(() => Promise.resolve()),
    isTauri: vi.fn(() => true),
    getCurrentWindow: vi.fn(),
  }),
);
getCurrentWindow.mockReturnValue({ onCloseRequested, destroy });

vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow }));

function Guard({
  recordingLocally,
  role,
}: {
  recordingLocally: boolean;
  role: "host" | "guest";
}) {
  useDesktopCloseGuard(recordingLocally, role);
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  isTauri.mockReturnValue(true);
  getCurrentWindow.mockReturnValue({ onCloseRequested, destroy });
});

describe("useDesktopCloseGuard", () => {
  it("uses role-aware copy", () => {
    expect(recordingCloseMessage("host")).toContain("session for everyone");
    expect(recordingCloseMessage("guest")).toContain("your local recording");
  });

  it("does not install a native listener while inactive or in the browser", () => {
    const { unmount } = render(<Guard recordingLocally={false} role="host" />);
    expect(onCloseRequested).not.toHaveBeenCalled();
    unmount();

    isTauri.mockReturnValue(false);
    render(<Guard recordingLocally role="guest" />);
    expect(onCloseRequested).not.toHaveBeenCalled();
  });

  it("prevents close before confirming and destroys only after confirmation", async () => {
    const unlisten = vi.fn();
    onCloseRequested.mockResolvedValue(unlisten);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Guard recordingLocally role="guest" />);

    expect(onCloseRequested).toHaveBeenCalledOnce();
    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => void;
    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(
      "Recording is in progress. Closing now will lose your local recording. Close Sharecut Studio anyway?",
    );
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });

  it("keeps the window open when confirmation is declined", () => {
    onCloseRequested.mockResolvedValue(vi.fn());
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Guard recordingLocally role="host" />);

    const handler = onCloseRequested.mock.calls[0][0] as (event: {
      preventDefault: () => void;
    }) => void;
    const preventDefault = vi.fn();
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("removes the close listener when local capture stops", async () => {
    const unlisten = vi.fn();
    onCloseRequested.mockResolvedValue(unlisten);
    const { rerender } = render(<Guard recordingLocally role="host" />);
    rerender(<Guard recordingLocally={false} role="host" />);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});
