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
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../test/renderWithModels";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../types/pipeline";
import { ApiError } from "../utils/apiError";
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
    setChrome({ exportDialogOpen: false });
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject(),
      guestMode: null,
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
    expect(dialog.textContent).toContain(
      "Includes current SRT captions and a Markdown transcript when available.",
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
    expect(useDawStore.getState().chrome.exportDialogOpen).toBe(false);
  });

  it("shows why Cancel is disabled as text until the export has started", async () => {
    const user = userEvent.setup();
    let startResolve!: (job: PipelineJobSnapshot) => void;
    vi.mocked(startExportJob).mockImplementation(
      () =>
        new Promise((resolve) => {
          startResolve = resolve;
        }),
    );
    heldFollow();
    render(<ExportDialog />);
    await openAndExport(user);

    const cancel = await screen.findByRole("button", { name: "Cancel export" });
    expect(cancel).toBeDisabled();
    const note = screen.getByText(
      "The export is still starting. Cancel once it has started.",
    );
    expect(note).toBeVisible();
    expect(note).not.toHaveAttribute("role");
    expect(cancel).toHaveAttribute("aria-describedby", note.id);
    expect(cancel).toHaveAccessibleDescription(note.textContent ?? "");

    await act(async () => startResolve(started));
    await waitFor(() => expect(cancel).toBeEnabled());
    expect(
      screen.queryByText(
        "The export is still starting. Cancel once it has started.",
      ),
    ).toBeNull();
    expect(cancel).not.toHaveAttribute("aria-describedby");
    expect(
      document.querySelector(".bounce-dialog-footer .export-dialog-note"),
    ).toBeNull();

    await user.click(cancel);
    const cancelling = await screen.findByRole("button", {
      name: "Cancelling…",
    });
    const cancellingNote = screen.getByText("Already cancelling the export.");
    expect(cancellingNote).toBeVisible();
    expect(cancelling).toHaveAttribute("aria-describedby", cancellingNote.id);
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
    expect(exportBtn).toHaveAccessibleDescription(
      "Choose at least one format.",
    );
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

  describe("model gate", () => {
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
      renderWithModels(<ExportDialog />, {
        status: modelStatus(registryRows()),
        download: downloadModel,
      });

    beforeEach(() => {
      downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
    });

    it("asks inside the same dialog and exports once more after the download", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      const { api } = renderGated();
      await openAndExport(user);

      expect(await screen.findByText(/stored on this computer/)).toBeTruthy();
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog")).toHaveAccessibleName(
        "Export deliverables",
      );
      expect(api.download).not.toHaveBeenCalled();
      expect(startExportJob).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Download" }));
      expect(
        await screen.findByText("Exported 2 files to export/"),
      ).toBeTruthy();
      expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
      expect(startExportJob).toHaveBeenCalledTimes(2);
    });

    it("fails with a hint when the person declines", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      renderGated();
      await openAndExport(user);
      await user.click(await screen.findByRole("button", { name: "Not now" }));

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Export failed: Noise reduction (RNNoise) is not downloaded.",
      );
      expect(screen.getByText(/Export will ask again/)).toBeTruthy();
      expect(startExportJob).toHaveBeenCalledTimes(1);
    });

    it("returns to settings, not a failure, when the project changes during the ask", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      renderGated();
      await openAndExport(user);
      await screen.findByRole("button", { name: "Not now" });

      act(() =>
        useDawStore.setState({ projectPath: "/tmp/other.project.json" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Not now" })).toBeNull(),
      );
      act(() => useDawStore.setState({ projectPath: PATH }));
      expect(
        await screen.findByRole("button", { name: "Export" }),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("does not loop when the same model is still missing after the download", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      renderGated();
      await openAndExport(user);
      await user.click(await screen.findByRole("button", { name: "Download" }));

      expect((await screen.findByRole("alert")).textContent).toContain(
        "Export failed:",
      );
      expect(startExportJob).toHaveBeenCalledTimes(2);
    });

    it("keeps the dialog open when Escape declines the prompt", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      renderGated();
      await openAndExport(user);
      await screen.findByRole("button", { name: "Download" });
      await user.keyboard("{Escape}");

      expect(
        await screen.findByRole("button", { name: "Try again" }),
      ).toBeTruthy();
      expect(useDawStore.getState().chrome.exportDialogOpen).toBe(true);
    });

    it("cannot be closed while the model downloads", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      downloadModel.mockReturnValue(new Promise(() => undefined));
      renderGated();
      await openAndExport(user);
      await user.click(await screen.findByRole("button", { name: "Download" }));
      await screen.findByRole("button", { name: "Cancel download" });
      await user.keyboard("{Escape}");

      expect(useDawStore.getState().chrome.exportDialogOpen).toBe(true);
      expect(
        screen.getByRole("button", { name: "Cancel download" }),
      ).toBeTruthy();
    });

    it("opens no prompt when the dialog was closed before the job failed", async () => {
      const user = userEvent.setup();
      const settle = heldFollow();
      renderGated();
      await openAndExport(user);
      await screen.findByRole("button", { name: "Cancel export" });
      act(() => useDawStore.getState().setExportDialogOpen(false));
      await act(async () => settle().fail(needed()));

      expect(screen.queryByRole("dialog")).toBeNull();
      act(() => useDawStore.getState().setExportDialogOpen(true));
      expect(
        await screen.findByRole("button", { name: "Export" }),
      ).toBeTruthy();
      expect(screen.queryByText(/stored on this computer/)).toBeNull();
      expect(downloadModel).not.toHaveBeenCalled();
    });

    it("shows a plain failure for any other error", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
      renderGated();
      await openAndExport(user);

      expect((await screen.findByRole("alert")).textContent).toBe(
        "Export failed: ffmpeg exited 1",
      );
      expect(screen.queryByText(/stored on this computer/)).toBeNull();
    });

    it("is axe-clean while asking", async () => {
      const user = userEvent.setup();
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      const { baseElement } = renderGated();
      await openAndExport(user);
      await screen.findByRole("button", { name: "Download" });
      await expectNoA11yViolations(baseElement);
    });
  });
});
