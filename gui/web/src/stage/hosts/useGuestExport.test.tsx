import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ start: vi.fn(), failed: vi.fn() }));
vi.mock("../../api", () => ({
  startGuestExport: api.start,
  guestExportFailed: api.failed,
}));

import { ApiError } from "../../utils/apiError";
import { useGuestExport } from "./useGuestExport";

const KEY = "share:tok";

type Files = Parameters<typeof useGuestExport>[1];
const files = (over: Partial<Files> = {}): Files => ({
  exporting: false,
  currentLoad: "ready",
  reload: vi.fn(),
  ...over,
});

beforeEach(() => {
  api.start.mockReset().mockResolvedValue(undefined);
  api.failed.mockReset().mockResolvedValue(false);
});

function mount(initial: Files) {
  return renderHook(({ f }) => useGuestExport(KEY, f), {
    initialProps: { f: initial },
  });
}

describe("useGuestExport", () => {
  it("holds starting until a files read after the start settles, then checks the job once", async () => {
    const reload = vi.fn(() =>
      rerender({ f: files({ currentLoad: "loading", reload }) }),
    );
    const { result, rerender } = mount(files({ reload }));
    await act(async () => result.current.start());
    expect(api.start).toHaveBeenCalledWith(KEY);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.starting).toBe(true);

    rerender({ f: files({ currentLoad: "ready", exporting: true }) });
    await waitFor(() => expect(result.current.starting).toBe(false));
    expect(api.failed).not.toHaveBeenCalled();

    rerender({ f: files({ currentLoad: "ready", exporting: false }) });
    await waitFor(() => expect(api.failed).toHaveBeenCalledTimes(1));
    expect(result.current.error).toBeNull();
    rerender({ f: files({ currentLoad: "ready", exporting: false }) });
    expect(api.failed).toHaveBeenCalledTimes(1);
  });

  it("sends one request for two presses in the same frame", async () => {
    const { result } = mount(files());
    await act(async () => {
      result.current.start();
      result.current.start();
    });
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, "job_running", "Another job is running. Try again shortly.", true],
    [
      403,
      "share_capability_required",
      "Exports from this link are not allowed.",
      true,
    ],
    [429, null, "Too many requests. Try again soon.", false],
    [500, null, "The export could not be started. Try again.", true],
  ])(
    "shows fixed copy for a %s and lets the next press through",
    async (status, code, copy, reloads) => {
      api.start.mockRejectedValueOnce(
        new ApiError("host words that must not show", code, status),
      );
      const initial = files();
      const { result } = mount(initial);
      await act(async () => result.current.start());
      expect(result.current.error).toBe(copy);
      expect(result.current.starting).toBe(false);
      expect(initial.reload).toHaveBeenCalledTimes(reloads ? 1 : 0);

      await act(async () => result.current.start());
      expect(api.start).toHaveBeenCalledTimes(2);
      expect(result.current.error).toBeNull();
    },
  );

  it("says a failed latest job did not finish, never with the server's text", async () => {
    api.failed.mockResolvedValue(true);
    const { result } = mount(files());
    await act(async () => result.current.start());
    await waitFor(() =>
      expect(result.current.error).toBe(
        "The export did not finish. Try again, or ask the host.",
      ),
    );
  });
});
