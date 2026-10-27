import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { followJobToOk, startBounceJob } from "../../api";
import { useDawStore } from "../../state/dawStore";
import { expectNoA11yViolations } from "../../test/a11y";
import { setChrome } from "../../test/chrome";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { ApiError } from "../../utils/apiError";
import { BounceDialog } from "./BounceDialog";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
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
    setChrome({ bounceDialogOpen: false });
    useDawStore.setState({
      bounceRangeTarget: null,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      selection: null,
      soloTracks: {},
      sessionRegion: null,
      pendingJobResults: {},
    });
    vi.mocked(startBounceJob).mockReset();
    vi.mocked(followJobToOk).mockReset();
  });

  it("shows bounce dialog and is axe-clean", async () => {
    useDawStore.getState().setBounceDialogOpen(true);
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
    useDawStore.getState().setBounceDialogOpen(true);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    });
    await user.keyboard("{Escape}");
    expect(useDawStore.getState().chrome.bounceDialogOpen).toBe(false);
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
    useDawStore.getState().setBounceDialogOpen(true);
    const bounceBtn = await screen.findByRole("button", { name: "Bounce" });
    await user.click(bounceBtn);
    await waitFor(() => {
      expect(followJobToOk).toHaveBeenCalled();
    });
    expect(captured?.aborted).toBe(false);
    useDawStore.getState().setBounceDialogOpen(false);
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
    useDawStore.getState().setBounceDialogOpen(true);
    const bounceBtn = await screen.findByRole("button", { name: "Bounce" });
    await user.click(bounceBtn);
    await waitFor(() => {
      expect(useDawStore.getState().chrome.bounceDialogOpen).toBe(false);
    });
    // useJobStatusAnnouncement owns speaking this once the "b1" chip goes
    // terminal (#704); BounceDialog itself must not race it via announceStatus.
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Bounced 2 file(s) to export/bounces/",
    });
  });
});

describe("BounceDialog model gate", () => {
  const needed = (id = "rnnoise") =>
    new ApiError("needs RNNoise", "model_needed", 409, {
      id,
      variant: null,
      label: "Noise reduction (RNNoise)",
      purpose: "noise reduction",
      size: "~0.3 MB",
      sizeBytes: null,
      state: "missing",
    });
  const downloadModel = vi.fn();
  const renderGated = () =>
    renderWithModels(<BounceDialog />, {
      status: modelStatus(registryRows()),
      download: downloadModel,
    });
  const bounce = async (user: ReturnType<typeof userEvent.setup>) => {
    useDawStore.getState().setBounceDialogOpen(true);
    await user.click(await screen.findByRole("button", { name: "Bounce" }));
  };

  beforeEach(() => {
    setChrome({ bounceDialogOpen: false });
    useDawStore.setState({
      bounceRangeTarget: null,
      projectPath: "/tmp/ep.project.json",
      project: projectStub,
      selection: null,
      soloTracks: {},
      sessionRegion: null,
      pendingJobResults: {},
    });
    vi.mocked(startBounceJob).mockReset().mockResolvedValue(bounceJobSnapshot);
    vi.mocked(followJobToOk).mockReset();
    downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
  });

  it("asks inside the dialog and bounces once more after the download", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk)
      .mockRejectedValueOnce(needed())
      .mockResolvedValue(bounced("export/bounces/a.wav"));
    const { api } = renderGated();
    await bounce(user);

    expect(await screen.findByText(/stored on this computer/)).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(api.download).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() =>
      expect(useDawStore.getState().chrome.bounceDialogOpen).toBe(false),
    );
    expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
    expect(startBounceJob).toHaveBeenCalledTimes(2);
  });

  it("replaces the options with the prompt while it asks", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(needed());
    renderGated();
    await bounce(user);
    await screen.findByRole("button", { name: "Not now" });

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("keeps the form and a hint when the person declines", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(needed());
    renderGated();
    await bounce(user);
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("button", { name: "Bounce" })).toBeEnabled();
    expect(screen.getByText(/Bounce will ask again/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(startBounceJob).toHaveBeenCalledTimes(1);
  });

  it("does not loop when the same model is still missing after the download", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(needed());
    renderGated();
    await bounce(user);
    await user.click(await screen.findByRole("button", { name: "Download" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "needs RNNoise",
    );
    expect(startBounceJob).toHaveBeenCalledTimes(2);
  });

  it("keeps the dialog open when Escape declines the prompt", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(needed());
    renderGated();
    await bounce(user);
    await screen.findByRole("button", { name: "Download" });
    await user.keyboard("{Escape}");

    expect(await screen.findByRole("button", { name: "Bounce" })).toBeTruthy();
    expect(useDawStore.getState().chrome.bounceDialogOpen).toBe(true);
  });

  it("cannot be closed while the model downloads", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(needed());
    downloadModel.mockReturnValue(new Promise(() => undefined));
    renderGated();
    await bounce(user);
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await screen.findByRole("button", { name: "Cancel download" });
    await user.keyboard("{Escape}");

    expect(useDawStore.getState().chrome.bounceDialogOpen).toBe(true);
  });

  it("shows a plain failure for any other error", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
    renderGated();
    await bounce(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "ffmpeg exited 1",
    );
    expect(screen.queryByText(/stored on this computer/)).toBeNull();
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
  setChrome({ bounceDialogOpen: true });
  useDawStore.setState({
    project: projectStub,
    projectPath: "/tmp/ep.project.json",
    bounceRangeTarget: target,
    selection: { kind: "track", trackId: "other" },
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
