import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { followJobToOk, startBounceJob } from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { BounceDialog } from "./BounceDialog";

vi.mock("../api", () => ({
  startBounceJob: vi.fn(),
  followJobToOk: vi.fn(),
}));

const projectStub = {
  name: "ep",
  timeline_duration_sec: 60,
  tracks: [],
  clips: { tracks: {} },
} as never;

/** Shared start-job snapshot for tests that bounce once and inspect the result. */
const bounceJobSnapshot: PipelineJobSnapshot = {
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
};

/** A terminal ok snapshot that wrote `paths`. */
function bounced(...paths: string[]): PipelineJobSnapshot {
  return { ...bounceJobSnapshot, status: "ok", result: { paths } };
}

describe("BounceDialog", () => {
  beforeEach(() => {
    useDawStore.setState({
      bounceDialogOpen: false,
      bounceRangeTarget: null,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      selectedTrackIds: [],
      soloTracks: {},
      sessionRegion: null,
      pendingJobResults: {},
    });
    vi.mocked(startBounceJob).mockReset();
    vi.mocked(followJobToOk).mockReset();
  });

  it("shows bounce dialog and is axe-clean", async () => {
    useDawStore.setState({ bounceDialogOpen: true });
    const { baseElement: container } = render(<BounceDialog />);
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

  it("stops following the job when the dialog closes", async () => {
    const user = userEvent.setup();
    let captured: AbortSignal | undefined;
    vi.mocked(startBounceJob).mockResolvedValue(bounceJobSnapshot);
    vi.mocked(followJobToOk).mockImplementation(async (_id, _label, opts) => {
      captured = opts?.signal;
      return new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    render(<BounceDialog />);
    useDawStore.setState({ bounceDialogOpen: true });
    const bounceBtn = await screen.findByRole("button", { name: "Bounce" });
    await user.click(bounceBtn);
    await waitFor(() => {
      expect(followJobToOk).toHaveBeenCalled();
    });
    expect(captured?.aborted).toBe(false);
    useDawStore.setState({ bounceDialogOpen: false });
    await waitFor(() => {
      expect(captured?.aborted).toBe(true);
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });

  it("records the bounce result under its job id instead of announcing it directly", async () => {
    const user = userEvent.setup();
    vi.mocked(startBounceJob).mockResolvedValue(bounceJobSnapshot);
    vi.mocked(followJobToOk).mockResolvedValue(
      bounced("export/bounces/a.wav", "export/bounces/a.mp3"),
    );
    render(<BounceDialog />);
    useDawStore.setState({ bounceDialogOpen: true });
    const bounceBtn = await screen.findByRole("button", { name: "Bounce" });
    await user.click(bounceBtn);
    await waitFor(() => {
      expect(useDawStore.getState().bounceDialogOpen).toBe(false);
    });
    // useJobStatusAnnouncement owns speaking this once the "b1" chip goes
    // terminal (#704); BounceDialog itself must not race it via announceStatus.
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Bounced 2 file(s) to export/bounces/",
    });
  });
});

it("keeps an exact range preset when lane and transport selections change", async () => {
  const user = userEvent.setup();
  const target = {
    kind: "exact_range" as const,
    intervals: [
      { start: 11, end: 12 },
      { start: 14, end: 15 },
    ],
    track_ids: ["a"],
    clips: [],
    media_seals: { a: "seal" },
  };
  useDawStore.setState({
    project: projectStub,
    projectPath: "/tmp/ep.project.json",
    bounceDialogOpen: true,
    bounceRangeTarget: target,
    selectedTrackIds: ["other"],
    sessionRegion: { start_sec: 0, end_sec: 60 },
  });
  vi.mocked(startBounceJob).mockResolvedValue(bounceJobSnapshot);
  vi.mocked(followJobToOk).mockResolvedValue(
    bounced("export/bounces/range.wav"),
  );
  render(<BounceDialog />);
  expect(screen.queryByText("Entire mix")).toBeNull();
  expect(screen.getByText(/11.00–12.00 s/)).toBeTruthy();
  await user.click(screen.getByRole("checkbox", { name: /MP3/ }));
  await user.click(screen.getByRole("button", { name: "Bounce" }));
  await waitFor(() =>
    expect(startBounceJob).toHaveBeenCalledExactlyOnceWith(
      "/tmp/ep.project.json",
      {
        track_ids: null,
        start_s: null,
        end_s: null,
        formats: ["wav", "mp3"],
        exact_range: target,
      },
    ),
  );
});
