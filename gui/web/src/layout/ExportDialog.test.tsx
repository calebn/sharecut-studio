import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  loadPipelineConfig,
  startExportJob,
} from "../api";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import { ExportDialog } from "./ExportDialog";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadPipelineConfig: vi.fn(),
  startExportJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));

const PATH = "/tmp/ep/episode.project.json";

const config = {
  config: {
    export: {
      wav: true,
      formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
    },
    master: { integrated_lufs: -16, true_peak_db: -1.5 },
  },
} as unknown as PipelineConfigResponse;

const started: PipelineJobSnapshot = {
  id: "x1",
  project_path: PATH,
  from_step: null,
  only_step: null,
  kind: "export",
  status: "running",
  current: 1,
  total: 2,
  message: "Writing deliverables…",
  error: null,
  elapsed_sec: 12,
  steps: [],
};

const finished: PipelineJobSnapshot = {
  ...started,
  status: "ok",
  current: 2,
  result: {
    paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
    master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
  },
};

/** A follow that settles only when the test says so. */
function heldFollow() {
  let settle!: {
    ok: (job: PipelineJobSnapshot) => void;
    fail: (e: Error) => void;
  };
  vi.mocked(followJobToOk).mockImplementation(
    (_id, _label, opts) =>
      new Promise((resolve, reject) => {
        settle = { ok: resolve, fail: reject };
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  return () => settle;
}

async function openAndExport(user: ReturnType<typeof userEvent.setup>) {
  act(() => useDawStore.getState().setExportDialogOpen(true));
  await screen.findByRole("checkbox", { name: "MP3 · 128 kbps" });
  await user.click(screen.getByRole("button", { name: "Export" }));
}

describe("ExportDialog", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject(),
      guestMode: null,
      exportDialogOpen: false,
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
    });
    vi.mocked(loadPipelineConfig).mockReset().mockResolvedValue(config);
    vi.mocked(startExportJob).mockReset().mockResolvedValue(started);
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
  });

  it("shows the project's formats and loudness target before anything starts", async () => {
    const { baseElement } = render(<ExportDialog />);
    act(() => useDawStore.getState().setExportDialogOpen(true));

    const dialog = await screen.findByRole("dialog", {
      name: "Export deliverables",
    });
    const mp3 = await screen.findByRole("checkbox", { name: "MP3 · 128 kbps" });
    expect((mp3 as HTMLInputElement).checked).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "FLAC · lossless",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    const wav = screen.getByRole("checkbox", { name: "WAV · lossless master" });
    expect((wav as HTMLInputElement).disabled).toBe(true);
    expect(dialog.textContent).toContain(
      "Mastered to −16.0 LUFS, peaks under −1.5 dBTP.",
    );
    expect(startExportJob).not.toHaveBeenCalled();
    await expectNoA11yViolations(baseElement);
  });

  it("exports the chosen formats, shows progress, then lists what it wrote", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<ExportDialog />);
    act(() => useDawStore.getState().setExportDialogOpen(true));
    await user.click(
      await screen.findByRole("checkbox", { name: "FLAC · lossless" }),
    );
    await user.click(screen.getByRole("button", { name: "Export" }));

    expect(startExportJob).toHaveBeenCalledWith(PATH, [
      { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 },
      { ext: "flac", codec: "flac" },
    ]);
    expect(await screen.findByText("Writing deliverables…")).toBeTruthy();
    expect(screen.getByText("1/2 steps")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Export progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("50");

    await act(async () => settle().ok(finished));
    expect(await screen.findByText("Exported 2 files to export/")).toBeTruthy();
    expect(screen.getByText("ep.mp3")).toBeTruthy();
    expect(
      screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeTruthy();
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Exported 2 files to export/",
    });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useDawStore.getState().exportDialogOpen).toBe(false);
  });

  it("cancels the running job and says so", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<ExportDialog />);
    await openAndExport(user);

    await user.click(
      await screen.findByRole("button", { name: "Cancel export" }),
    );
    expect(cancelPipelineRun).toHaveBeenCalledWith("x1");
    expect(
      (screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...started, status: "cancelled" },
          "Export cancelled",
        ),
      ),
    );
    expect(
      await screen.findByText(
        "Export cancelled. Files from an earlier export are unchanged.",
      ),
    ).toBeTruthy();
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    await user.click(screen.getByRole("button", { name: "Export again" }));
    expect(await screen.findByRole("button", { name: "Export" })).toBeTruthy();
  });

  it("lists the files a cancel arrived too late to stop", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    const { baseElement } = render(<ExportDialog />);
    await openAndExport(user);
    await user.click(
      await screen.findByRole("button", { name: "Cancel export" }),
    );

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...finished, status: "cancelled" },
          "Export cancelled",
        ),
      ),
    );
    expect(
      await screen.findByText(
        "Cancel came too late. Exported 2 files to export/",
      ),
    ).toBeTruthy();
    expect(screen.getByText("ep.wav")).toBeTruthy();
    expect(screen.getByText("ep.mp3")).toBeTruthy();
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Cancel came too late. Exported 2 files to export/",
    });
    await expectNoA11yViolations(baseElement);
  });

  it("names a failure and offers Try again", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
    render(<ExportDialog />);
    await openAndExport(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Export failed: ffmpeg exited 1",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("checkbox", { name: "MP3 · 128 kbps" }),
    ).toBeTruthy();
  });

  it("keeps the export running when the dialog closes, and shows it again on reopen", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<ExportDialog />);
    await openAndExport(user);
    await screen.findByRole("button", { name: "Cancel export" });

    act(() => useDawStore.getState().setExportDialogOpen(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useDawStore.getState().setExportDialogOpen(true));
    expect(
      await screen.findByRole("button", { name: "Cancel export" }),
    ).toBeTruthy();
    expect(startExportJob).toHaveBeenCalledTimes(1);

    await act(async () => settle().ok(finished));
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Exported 2 files to export/",
    });
  });

  it("blocks Export with its reason when no format is left", async () => {
    vi.mocked(loadPipelineConfig).mockResolvedValue({
      config: { export: { wav: false, formats: [{ ext: "mp3" }] } },
    } as unknown as PipelineConfigResponse);
    const user = userEvent.setup();
    render(<ExportDialog />);
    act(() => useDawStore.getState().setExportDialogOpen(true));
    await user.click(await screen.findByRole("checkbox", { name: "MP3" }));

    const exportBtn = screen.getByRole("button", { name: "Export" });
    expect((exportBtn as HTMLButtonElement).disabled).toBe(true);
    expect(exportBtn.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(exportBtn.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Choose at least one format.");
  });

  it("returns to settings and announces nothing when the project changes", async () => {
    const user = userEvent.setup();
    heldFollow();
    render(<ExportDialog />);
    await openAndExport(user);
    await screen.findByRole("button", { name: "Cancel export" });

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() =>
      expect(useDawStore.getState().pendingJobResults).toEqual({}),
    );
    act(() => useDawStore.setState({ projectPath: PATH }));
    expect(await screen.findByRole("button", { name: "Export" })).toBeTruthy();
  });
});
