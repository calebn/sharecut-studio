import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import {
  _resetPageCloseRiskForTests,
  publishDesktopCloseGuard,
} from "../desktop/useDesktopCloseGuard";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { clearRegisteredCommands, execute } from "./execute";
import { PROJECT_CLOSE_TIMEOUT_MS, PROJECT_NEW_RETRY_MS } from "./projectMedia";
import { runAndAnnounceRefusal } from "./refusal";
import {
  _resetProjectOpenInFlightForTests,
  registerDawCommands,
} from "./register";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    pickEpisodeProject: vi.fn(),
    openEpisodeProject: vi.fn(),
    closeEpisodeProject: vi.fn(),
  };
});

const pickMock = vi.mocked(api.pickEpisodeProject);
const openMock = vi.mocked(api.openEpisodeProject);
const closeMock = vi.mocked(api.closeEpisodeProject);

describe("project.open", () => {
  const assign = vi.fn();

  beforeEach(() => {
    clearRegisteredCommands();
    _resetProjectOpenInFlightForTests();
    registerDawCommands();
    pickMock.mockReset();
    openMock.mockReset();
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    assign.mockReset();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/",
      assign,
    });
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetProjectOpenInFlightForTests();
    _resetPageCloseRiskForTests();
  });

  it("picks then opens and navigates", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old",
      assign,
    });
    pickMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.sharecut",
    });
    openMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.sharecut",
      name: "episode",
    });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("/tmp/ep/episode.sharecut");
    });
    expect(assign).toHaveBeenCalled();
    const opened = new URL(String(assign.mock.calls[0]?.[0]));
    expect(opened.searchParams.get("project")).toBe("/tmp/ep/episode.sharecut");
    expect(opened.searchParams.has("sc_close_guard")).toBe(false);
  });

  it("blocks New while the native recording guard is armed", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&sc_close_guard=host",
      assign,
    });
    expect((await execute("project.new")).status).toBe("disabled");
    expect(assign).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("navigates to a new project without dropping unrelated URL state", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&theme=dark",
      assign,
    });
    expect((await execute("project.new")).status).toBe("ok");
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(closeMock.mock.invocationCallOrder[0]).toBeLessThan(
      assign.mock.invocationCallOrder[0] ?? 0,
    );
    const destination = new URL(String(assign.mock.calls[0]?.[0]));
    expect(destination.searchParams.has("project")).toBe(false);
    expect(destination.searchParams.get("home")).toBe("1");
    expect(destination.searchParams.get("theme")).toBe("dark");
  });

  it("New stays in Studio and reports a failed unpin", async () => {
    closeMock.mockRejectedValue(new Error("403 forbidden"));
    expect((await execute("project.new")).status).toBe("ok");
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "New project failed: 403 forbidden",
      ),
    );
    expect(assign).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("New ignores a repeat while the unpin is pending", async () => {
    closeMock.mockImplementationOnce(() => new Promise<void>(() => {}));
    expect((await execute("project.new")).status).toBe("ok");
    expect((await execute("project.new")).status).toBe("ok");
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().statusAnnouncement).toBe("Closing project…");
    expect(assign).not.toHaveBeenCalled();
  });

  it("New gives up on a stalled unpin", async () => {
    vi.useFakeTimers();
    try {
      closeMock.mockImplementationOnce(
        (signal?: AbortSignal) =>
          new Promise<void>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      );
      openMock.mockResolvedValue({ project_path: "/tmp/ep", name: "ep" });
      expect((await execute("project.new")).status).toBe("ok");
      await vi.advanceTimersByTimeAsync(PROJECT_CLOSE_TIMEOUT_MS);
      expect(useDawStore.getState().statusAnnouncement).toContain("timed out");
      expect(assign).not.toHaveBeenCalled();
      expect(openMock).toHaveBeenCalledWith("/tmp/ep");
    } finally {
      vi.useRealTimers();
    }
  });

  it("New does not re-pin a share project after a stalled unpin", async () => {
    useDawStore.setState({ projectPath: shareProjectKey("tok") });
    vi.useFakeTimers();
    try {
      closeMock.mockImplementationOnce(
        (signal?: AbortSignal) =>
          new Promise<void>((_, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason));
          }),
      );
      expect(
        (await execute("project.new", {}, { skipWhen: true })).status,
      ).toBe("ok");
      await vi.advanceTimersByTimeAsync(PROJECT_CLOSE_TIMEOUT_MS);
      expect(useDawStore.getState().statusAnnouncement).toContain("timed out");
      expect(assign).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks New while this browser tab is recording", async () => {
    publishDesktopCloseGuard(true, "host");
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    const result = await runAndAnnounceRefusal(() => execute("project.new"));
    expect(result).toEqual({
      status: "disabled",
      reason: "Stop the take before switching projects",
      told: true,
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      "Stop the take before switching projects",
      { tone: "error" },
    );
    expect(closeMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("New works again when the page stays after navigating", async () => {
    vi.useFakeTimers();
    try {
      expect((await execute("project.new")).status).toBe("ok");
      await vi.advanceTimersByTimeAsync(0);
      expect(assign).toHaveBeenCalledTimes(1);
      expect((await execute("project.new")).status).toBe("ok");
      expect(closeMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROJECT_NEW_RETRY_MS);
      expect((await execute("project.new")).status).toBe("ok");
      await vi.advanceTimersByTimeAsync(0);
      expect(closeMock).toHaveBeenCalledTimes(2);
      expect(assign).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks Open before showing a picker while the guard is armed", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&sc_close_guard=host",
      assign,
    });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    const result = await runAndAnnounceRefusal(() => execute("project.open"));
    expect(result).toEqual({
      status: "disabled",
      reason: "Stop the take before switching projects",
      told: true,
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(pickMock).not.toHaveBeenCalled();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("does not switch if the guard arms while the picker is open", async () => {
    let finishPick!: (value: { project_path: string }) => void;
    pickMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPick = resolve;
        }),
    );
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => expect(pickMock).toHaveBeenCalled());
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&sc_close_guard=host",
      assign,
    });
    await act(async () => {
      finishPick({ project_path: "/tmp/new/episode.sharecut" });
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("ignores overlapping invocations until pick finishes", async () => {
    let finishPick!: (value: { cancelled: true }) => void;
    pickMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPick = resolve;
        }),
    );
    expect((await execute("project.open")).status).toBe("ok");
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(pickMock).toHaveBeenCalledTimes(1);
    });
    finishPick({ cancelled: true });
    await waitFor(() => {
      expect(openMock).not.toHaveBeenCalled();
    });
  });

  it("does not open on cancel", async () => {
    pickMock.mockResolvedValue({ cancelled: true });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(pickMock).toHaveBeenCalled();
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("announces cancel detail", async () => {
    pickMock.mockResolvedValue({
      cancelled: true,
      detail: "File dialog timed out.",
    });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "File dialog timed out.",
      );
    });
    expect(openMock).not.toHaveBeenCalled();
  });

  it("goes to Home's path field when no folder picker exists", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=%2Ftmp%2Fep",
      assign,
    });
    pickMock.mockResolvedValue({
      unavailable: true,
      detail: "install zenity",
    });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(assign).toHaveBeenCalledOnce();
    });
    const home = new URL(String(assign.mock.calls[0]?.[0]));
    expect(home.searchParams.get("home")).toBe("1");
    expect(home.searchParams.get("openOther")).toBe("1");
    expect(home.searchParams.has("project")).toBe(false);
    expect(openMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("announces open failure", async () => {
    pickMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.sharecut",
    });
    openMock.mockRejectedValue(new Error("not a project"));
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Open failed: not a project",
      );
    });
    expect(assign).not.toHaveBeenCalled();
  });
  describe("with a path", () => {
    const GUARDED = "http://127.0.0.1:8765/?project=old&sc_close_guard=host";

    it("opens that path without the picker", async () => {
      vi.stubGlobal("location", {
        href: "http://127.0.0.1:8765/?project=old",
        assign,
      });
      openMock.mockResolvedValue({ project_path: "/p/show", name: "show" });
      expect(
        (await execute("project.open", { path: " /p/show " })).status,
      ).toBe("ok");
      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(pickMock).not.toHaveBeenCalled();
      expect(openMock).toHaveBeenCalledWith("/p/show");
      const opened = new URL(String(assign.mock.calls[0]?.[0]));
      expect(opened.searchParams.get("project")).toBe("/p/show");
    });

    it("is refused while the guard is armed", async () => {
      vi.stubGlobal("location", { href: GUARDED, assign });
      expect((await execute("project.open", { path: "/p/show" })).status).toBe(
        "disabled",
      );
      expect(openMock).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    });

    it("does not switch if the guard arms before the open answers", async () => {
      let finishOpen!: (v: { project_path: string; name: string }) => void;
      openMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOpen = resolve;
          }),
      );
      expect((await execute("project.open", { path: "/p/show" })).status).toBe(
        "ok",
      );
      await waitFor(() => expect(openMock).toHaveBeenCalled());
      vi.stubGlobal("location", { href: GUARDED, assign });
      await act(async () => {
        finishOpen({ project_path: "/p/show", name: "show" });
      });
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Stop the take before switching projects",
        ),
      );
      expect(assign).not.toHaveBeenCalled();
    });

    it("ignores a repeat while an open is in flight", async () => {
      openMock.mockImplementation(() => new Promise(() => {}));
      expect((await execute("project.open", { path: "/p/a" })).status).toBe(
        "ok",
      );
      expect((await execute("project.open", { path: "/p/b" })).status).toBe(
        "ok",
      );
      await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
      expect(openMock).toHaveBeenCalledWith("/p/a");
    });

    it("falls back to the picker for a blank or non-string path", async () => {
      pickMock.mockResolvedValue({ cancelled: true });
      await execute("project.open", { path: "   " });
      await waitFor(() => expect(pickMock).toHaveBeenCalledTimes(1));
      _resetProjectOpenInFlightForTests();
      await execute("project.open", { path: 7 });
      await waitFor(() => expect(pickMock).toHaveBeenCalledTimes(2));
      expect(openMock).not.toHaveBeenCalled();
    });
  });
});
