import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeEpisodeProject,
  createEpisodeProject,
  fetchDiagnosticsMeta,
  openEpisodeProject,
  pickEpisodeProject,
} from "../api";
import { expectNoA11yViolations } from "../test/a11y";
import { HomeScreen } from "./HomeScreen";

vi.mock("../api", () => ({
  closeEpisodeProject: vi.fn(),
  createEpisodeProject: vi.fn(),
  openEpisodeProject: vi.fn(),
  pickEpisodeProject: vi.fn(),
  createDiagnosticsBundle: vi.fn(),
  fetchDiagnosticsMeta: vi.fn(),
}));

const closeMock = vi.mocked(closeEpisodeProject);
const createMock = vi.mocked(createEpisodeProject);
const openMock = vi.mocked(openEpisodeProject);
const pickMock = vi.mocked(pickEpisodeProject);
const metaMock = vi.mocked(fetchDiagnosticsMeta);

describe("HomeScreen", () => {
  const assign = vi.fn();

  beforeEach(() => {
    window.localStorage.setItem("sharecut.bootstrap.skip", "1");
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    createMock.mockReset();
    openMock.mockReset();
    pickMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue({
      support_url: "https://support.example.test",
      privacy_url: "https://privacy.example.test",
      repository_url: "https://code.example.test/sharecut",
      release_manifest_url: null,
    });
    assign.mockReset();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/",
      assign,
    });
  });

  it("keeps an armed recording marker and blocks project switching", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("location", {
      href: "http://127.0.0.1:8765/?sc_close_guard=host",
      assign,
    });
    render(<HomeScreen />);
    expect(closeMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "New project…" }));
    await user.type(
      screen.getByLabelText("Workspace directory"),
      "/tmp/workspace",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Return to the recording project",
    );
    expect(createMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("creates a project from New → Create", async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
      name: "episode",
    });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "New project…" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "ep");
    await user.type(
      screen.getByLabelText("Workspace directory"),
      "/tmp/workspace",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(createMock).toHaveBeenCalledWith("/tmp/workspace", "ep");
    });
    expect(assign).toHaveBeenCalled();
    const created = new URL(String(assign.mock.calls[0]?.[0]));
    expect(created.searchParams.get("project")).toBe(
      "/tmp/ep/episode.project.json",
    );
  });

  it("opens a project from Open → Open", async () => {
    const user = userEvent.setup();
    openMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
      name: "episode",
    });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.type(
      screen.getByLabelText("episode.project.json"),
      "/tmp/ep/episode.project.json",
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("/tmp/ep/episode.project.json");
    });
    expect(assign).toHaveBeenCalled();
    const opened = new URL(String(assign.mock.calls[0]?.[0]));
    expect(opened.searchParams.get("project")).toBe(
      "/tmp/ep/episode.project.json",
    );
  });

  it("Browse… picks then opens immediately", async () => {
    const user = userEvent.setup();
    pickMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
    });
    openMock.mockResolvedValue({
      project_path: "/tmp/ep/episode.project.json",
      name: "episode",
    });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => {
      expect(pickMock).toHaveBeenCalled();
      expect(openMock).toHaveBeenCalledWith("/tmp/ep/episode.project.json");
    });
    expect(assign).toHaveBeenCalled();
    const browsed = new URL(String(assign.mock.calls[0]?.[0]));
    expect(browsed.searchParams.get("project")).toBe(
      "/tmp/ep/episode.project.json",
    );
  });

  it("Browse… cancel leaves the form", async () => {
    const user = userEvent.setup();
    pickMock.mockResolvedValue({ cancelled: true });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => {
      expect(pickMock).toHaveBeenCalled();
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Browse…" })).toBeInTheDocument();
  });

  it("Browse… cancel with detail shows alert", async () => {
    const user = userEvent.setup();
    pickMock.mockResolvedValue({
      cancelled: true,
      detail: "File dialog timed out.",
    });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File dialog timed out.",
    );
    expect(openMock).not.toHaveBeenCalled();
  });

  it("sets aria-busy on the open form while Browse is in flight", async () => {
    const user = userEvent.setup();
    let finishPick!: (value: { cancelled: true }) => void;
    pickMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPick = resolve;
        }),
    );
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    const form = document.querySelector("form.box.elevated");
    expect(form).toHaveAttribute("aria-busy", "true");
    finishPick({ cancelled: true });
    await waitFor(() => {
      expect(form).not.toHaveAttribute("aria-busy");
    });
  });

  it("Browse… unavailable shows alert and keeps paste field", async () => {
    const user = userEvent.setup();
    pickMock.mockResolvedValue({
      unavailable: true,
      detail: "install zenity",
    });
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "install zenity",
    );
    expect(openMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("episode.project.json")).toBeInTheDocument();
  });

  it("returns to idle on Cancel", async () => {
    const user = userEvent.setup();
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "New project…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "New project…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open project…" }),
    ).toBeInTheDocument();
  });

  it("shows role=alert when create fails", async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValue(new Error("disk full"));
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "New project…" }));
    await user.type(
      screen.getByLabelText("Workspace directory"),
      "/tmp/workspace",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  });

  it("is axe-clean on idle, new, and open", async () => {
    const user = userEvent.setup();
    const { container } = render(<HomeScreen />);
    await expectNoA11yViolations(container);

    await user.click(screen.getByRole("button", { name: "New project…" }));
    expect(container.querySelector("form.box.elevated")).toBeTruthy();
    expect(container.querySelector("header.box")).toBeNull();
    await expectNoA11yViolations(container);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open project…" }));
    expect(container.querySelector("form.box.elevated")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("skips the wizard when sharecut.bootstrap.skip is set", async () => {
    window.localStorage.clear();
    window.localStorage.setItem("sharecut.bootstrap.skip", "1");
    render(<HomeScreen />);
    expect(
      screen.getByRole("heading", { name: "Sharecut Studio" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "New project…" })).toBeTruthy();
  });

  it("opens Connect agent from home and unpins the served project", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const user = userEvent.setup();
    render(<HomeScreen />);
    await waitFor(() => {
      expect(closeMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole("button", { name: "Connect agent…" }));
    expect(
      await screen.findByRole("dialog", { name: "Connect agent" }),
    ).toBeTruthy();
    expect(screen.getByText(/Open an episode first/)).toBeTruthy();
  });

  it("opens Help from home", async () => {
    const user = userEvent.setup();
    render(<HomeScreen />);
    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("dialog", { name: "Help" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create diagnostics bundle" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("link", { name: "Open support" }),
    ).toHaveAttribute("href", "https://support.example.test");
  });
});
