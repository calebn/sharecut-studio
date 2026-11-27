import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands, listRegisteredIds } from "../commands/execute";
import { _resetProjectOpenInFlightForTests } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { ApiError } from "../utils/apiError";
import { OpenProjectFileHost } from "./OpenProjectFileHost";
import {
  _resetOpenProjectFileForTests,
  captureBootProjectFile,
  OPEN_PROJECT_FILE_EVENT,
  OPEN_PROJECT_QUEUE_KEY,
} from "./openProjectFile";
import {
  _resetPageCloseRiskForTests,
  CLOSE_GUARD_PARAM,
} from "./useDesktopCloseGuard";

const { isTauri, openEpisodeProject } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  openEpisodeProject: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openEpisodeProject,
}));

const PATH = "/Users/ana/My Show/100% done/episode.sharecut";
const said = () => useDawStore.getState().statusAnnouncement;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function push(path: string) {
  const holder = window as unknown as Record<string, unknown>;
  const queue = (holder[OPEN_PROJECT_QUEUE_KEY] as string[] | undefined) ?? [];
  queue.push(path);
  holder[OPEN_PROJECT_QUEUE_KEY] = queue;
  act(() => {
    window.dispatchEvent(
      new CustomEvent(OPEN_PROJECT_FILE_EVENT, { detail: { path } }),
    );
  });
}

beforeEach(() => {
  isTauri.mockReturnValue(true);
  openEpisodeProject.mockReset();
  openEpisodeProject.mockReturnValue(new Promise(() => undefined));
  clearRegisteredCommands();
  _resetProjectOpenInFlightForTests();
  _resetOpenProjectFileForTests();
  useDawStore.setState({ projectPath: "", statusAnnouncement: "" });
  window.history.replaceState({ k: 1 }, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  _resetPageCloseRiskForTests();
  _resetProjectOpenInFlightForTests();
});

describe("OpenProjectFileHost", () => {
  it("opens the file in the launch fragment and clears it from the URL", async () => {
    window.history.replaceState(
      { k: 1 },
      "",
      `/?x=1#open-project=${encodeURIComponent(PATH)}`,
    );
    captureBootProjectFile();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?x=1");
    expect(window.history.state).toEqual({ k: 1 });
    render(<OpenProjectFileHost />);
    await flush();
    expect(openEpisodeProject).toHaveBeenCalledExactlyOnceWith(PATH);
  });

  it("registers project.open itself when the host mounts before any screen did", async () => {
    window.history.replaceState(
      null,
      "",
      `/#open-project=${encodeURIComponent(PATH)}`,
    );
    captureBootProjectFile();
    expect(listRegisteredIds()).not.toContain("project.open");
    render(<OpenProjectFileHost />);
    await flush();
    expect(listRegisteredIds()).toContain("project.open");
    expect(openEpisodeProject).toHaveBeenCalledWith(PATH);
    expect(openEpisodeProject).toHaveBeenCalledTimes(1);
  });

  it("registers project.open itself for a path queued before the host mounted", async () => {
    (window as unknown as Record<string, unknown>)[OPEN_PROJECT_QUEUE_KEY] = [
      PATH,
    ];
    expect(listRegisteredIds()).not.toContain("project.open");
    render(<OpenProjectFileHost />);
    await flush();
    expect(openEpisodeProject).toHaveBeenCalledExactlyOnceWith(PATH);
  });

  it("keeps other fragment parts and ignores a malformed encoding", async () => {
    window.history.replaceState(null, "", "/#a=1&open-project=%E0%A4%A&b=2");
    captureBootProjectFile();
    expect(window.location.hash).toBe("#a=1&b=2");
    render(<OpenProjectFileHost />);
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
  });

  it("leaves the URL alone when there is no launch fragment", async () => {
    window.history.replaceState(null, "", "/#section");
    captureBootProjectFile();
    expect(window.location.hash).toBe("#section");
    render(<OpenProjectFileHost />);
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
  });

  it("runs a path queued before it mounted", async () => {
    (window as unknown as Record<string, unknown>)[OPEN_PROJECT_QUEUE_KEY] = [
      PATH,
    ];
    render(<OpenProjectFileHost />);
    await flush();
    expect(openEpisodeProject).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(
      (window as unknown as Record<string, unknown[]>)[OPEN_PROJECT_QUEUE_KEY],
    ).toEqual([]);
  });

  it("runs a path pushed while it is mounted and stops listening after unmount", async () => {
    const view = render(<OpenProjectFileHost />);
    push(PATH);
    await flush();
    expect(openEpisodeProject).toHaveBeenCalledExactlyOnceWith(PATH);
    view.unmount();
    openEpisodeProject.mockClear();
    push("/other/episode.sharecut");
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
  });

  it("does nothing when the project is already open", async () => {
    useDawStore.setState({ projectPath: PATH });
    render(<OpenProjectFileHost />);
    push(PATH);
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
  });

  it("says why a second project is refused during a recording and does not retry", async () => {
    window.history.replaceState(null, "", `/?${CLOSE_GUARD_PARAM}=host`);
    render(<OpenProjectFileHost />);
    push(PATH);
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
    expect(said()).toBe("Stop the take before switching projects");
    useDawStore.setState({ statusAnnouncement: "" });
    window.history.replaceState(null, "", "/");
    push(PATH);
    await flush();
    expect(openEpisodeProject).toHaveBeenCalledExactlyOnceWith(PATH);
    expect(said()).toBe("");
  });

  it("does not reload when the engine resolves the path to the open project", async () => {
    const resolved = "/private/tmp/ep/episode.sharecut";
    useDawStore.setState({ projectPath: resolved });
    openEpisodeProject.mockResolvedValue({ project_path: resolved });
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...real, href: real.href, assign },
    });
    try {
      render(<OpenProjectFileHost />);
      push("/tmp/ep/episode.sharecut");
      await flush();
      await flush();
      expect(openEpisodeProject).toHaveBeenCalledOnce();
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: real,
      });
    }
  });

  it("shows the engine's refusal as an open failure", async () => {
    openEpisodeProject.mockRejectedValue(
      new ApiError("expected episode.sharecut", "project_open_failed", 400),
    );
    render(<OpenProjectFileHost />);
    push("/Users/ana/copy of episode.sharecut");
    await flush();
    expect(said()).toMatch(/^Open failed: /);
  });

  it("does nothing outside the desktop app", async () => {
    isTauri.mockReturnValue(false);
    window.history.replaceState(
      null,
      "",
      `/#open-project=${encodeURIComponent(PATH)}`,
    );
    captureBootProjectFile();
    expect(window.location.hash).not.toBe("");
    render(<OpenProjectFileHost />);
    push(PATH);
    await flush();
    expect(openEpisodeProject).not.toHaveBeenCalled();
  });
});
