import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { followExportJob, startBounceJob } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { BounceDialog } from "./BounceDialog";

vi.mock("../api", () => ({
  startBounceJob: vi.fn(),
  followExportJob: vi.fn(),
}));

const projectStub = {
  name: "ep",
  timeline_duration_sec: 60,
  tracks: [],
  clips: { tracks: {} },
} as never;

describe("BounceDialog", () => {
  beforeEach(() => {
    useDawStore.setState({
      bounceDialogOpen: false,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      selectedTrackIds: [],
      soloTracks: {},
      sessionRegion: null,
    });
    vi.mocked(startBounceJob).mockReset();
    vi.mocked(followExportJob).mockReset();
  });

  it("shows bounce dialog and is axe-clean", async () => {
    useDawStore.setState({ bounceDialogOpen: true });
    const { container } = render(<BounceDialog />);
    const dialog = screen.getByRole("dialog", { name: "Bounce…" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("Entire mix")).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it("closes on Escape and restores opener focus", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button" data-testid="opener">
          Open bounce
        </button>
        <div data-daw-app-chrome />
        <BounceDialog />
      </div>,
    );
    screen.getByTestId("opener").focus();
    useDawStore.setState({ bounceDialogOpen: true });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(useDawStore.getState().bounceDialogOpen).toBe(false);
    await waitFor(() => {
      expect(screen.getByTestId("opener")).toHaveFocus();
    });
  });

  it("aborts followExportJob when the dialog closes", async () => {
    const user = userEvent.setup();
    let captured: AbortSignal | undefined;
    vi.mocked(startBounceJob).mockResolvedValue({
      id: "b1",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      kind: "bounce",
      status: "queued",
      current: null,
      total: null,
      message: "Bounce",
      error: null,
      elapsed_sec: 0,
      steps: [],
    });
    vi.mocked(followExportJob).mockImplementation(async (_id, _label, opts) => {
      captured = opts?.signal;
      await new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return [];
    });
    render(<BounceDialog />);
    useDawStore.setState({ bounceDialogOpen: true });
    const bounceBtn = await screen.findByRole("button", { name: "Bounce" });
    await user.click(bounceBtn);
    await waitFor(() => {
      expect(followExportJob).toHaveBeenCalled();
    });
    expect(captured?.aborted).toBe(false);
    useDawStore.setState({ bounceDialogOpen: false });
    await waitFor(() => {
      expect(captured?.aborted).toBe(true);
    });
  });
});
