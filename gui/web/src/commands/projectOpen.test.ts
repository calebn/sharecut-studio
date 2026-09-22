import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { clearRegisteredCommands, execute } from "./execute";
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
  };
});

const pickMock = vi.mocked(api.pickEpisodeProject);
const openMock = vi.mocked(api.openEpisodeProject);

describe("project.open", () => {
  const assign = vi.fn();
  const prompt = vi.fn();

  beforeEach(() => {
    clearRegisteredCommands();
    _resetProjectOpenInFlightForTests();
    registerDawCommands();
    pickMock.mockReset();
    openMock.mockReset();
    assign.mockReset();
    prompt.mockReset();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/",
      assign,
    });
    vi.stubGlobal("prompt", prompt);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetProjectOpenInFlightForTests();
  });

  it("picks then opens and navigates", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&sc_close_guard=host",
      assign,
    });
    pickMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
    });
    openMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
      name: "episode",
    });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("/tmp/ep/episode.project.json");
    });
    expect(assign).toHaveBeenCalled();
    const opened = new URL(String(assign.mock.calls[0]?.[0]));
    expect(opened.searchParams.get("project")).toBe(
      "/tmp/ep/episode.project.json",
    );
    expect(opened.searchParams.has("sc_close_guard")).toBe(false);
  });

  it("does not carry the old recording marker into a new project", async () => {
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?project=old&sc_close_guard=host",
      assign,
    });
    expect((await execute("project.new")).status).toBe("ok");
    const destination = new URL(String(assign.mock.calls[0]?.[0]));
    expect(destination.searchParams.has("project")).toBe(false);
    expect(destination.searchParams.has("sc_close_guard")).toBe(false);
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

  it("prompts when the dialog is unavailable", async () => {
    pickMock.mockResolvedValue({
      unavailable: true,
      detail: "install zenity",
    });
    prompt.mockReturnValue("/tmp/ep/episode.project.json");
    openMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
      name: "episode",
    });
    expect((await execute("project.open")).status).toBe("ok");
    await waitFor(() => {
      expect(prompt).toHaveBeenCalled();
      expect(openMock).toHaveBeenCalledWith("/tmp/ep/episode.project.json");
    });
  });

  it("announces open failure", async () => {
    pickMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
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
});
