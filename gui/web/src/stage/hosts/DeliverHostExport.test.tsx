import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/offlineQueue/offlineStore")
  >()),
  loadHostCommandQueue: async () => [],
  loadHostAttention: async () => ({ pending: 0, conflicts: [] }),
}));

import { clearRegisteredCommands, execute } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import {
  EXPORT_FINISHED,
  EXPORT_MODEL_NEEDED,
  EXPORT_STARTED,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";

const PATH = "/tmp/ep/episode.project.json";
const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };

let server: ReturnType<typeof fakeExportServer>;

function Stages() {
  const stage = useDawStore((s) => s.stage);
  return stage === "deliver" ? <DeliverStage /> : <p>another stage</p>;
}

function Host() {
  return (
    <ExportFlowProvider>
      <Stages />
    </ExportFlowProvider>
  );
}

const exportButton = () =>
  screen.getAllByRole("button", { name: "Export" })[0] as HTMLElement;

async function ready() {
  await waitFor(() => expect(exportButton()).toBeEnabled());
}

async function pressExport() {
  await ready();
  await userEvent.click(exportButton());
  await waitFor(() => expect(server.exportRequests).toHaveLength(1));
}

function asHost(path = PATH) {
  useDawStore
    .getState()
    .hydrate(path, minimalProject({ tracks: [sampleTrack()] }));
  useDawStore.setState({ stage: "deliver", guestMode: null });
}

beforeEach(() => {
  server = fakeExportServer();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.setState({ activityJob: null, pendingJobResults: {} });
  asHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Export on the Deliver stage", () => {
  it("offers the project's formats and says WAV is always written", async () => {
    render(<Host />);
    const formats = await screen.findByRole("group", { name: "Formats" });
    await waitFor(() =>
      expect(within(formats).getAllByRole("button")).toHaveLength(4),
    );
    expect(within(formats).getByRole("button", { name: "WAV" })).toBeDisabled();
    expect(
      within(formats).getByRole("button", { name: /^MP3/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(formats).getByRole("button", { name: /^FLAC/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/always written/)).toBeInTheDocument();
  });

  it("leaves Loudness, Range and Saves to out and says the loudness target", async () => {
    render(<Host />);
    await ready();
    expect(screen.queryByRole("group", { name: "Loudness" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    expect(screen.queryByText(/Saves to/)).toBeNull();
    expect(
      screen.getByText(/Mastered to −16\.0 LUFS, peaks under −1\.5 dBTP/),
    ).toBeInTheDocument();
  });

  it("posts the chosen formats to the export route", async () => {
    render(<Host />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    await userEvent.click(exportButton());
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3, { ext: "flac", codec: "flac" }],
    });
  });

  it("marks Exported as edited after the document changes", async () => {
    render(<Host />);
    await pressExport();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    const project = useDawStore.getState().project;
    if (!project) throw new Error("fixture");
    act(() =>
      useDawStore.setState({
        project: {
          ...project,
          history: {
            ...project.history,
            head_id: "after-the-export" as HistoryEntryId,
          },
        },
      }),
    );
    expect(await screen.findByText("Edited since export")).toBeInTheDocument();
    expect(screen.queryByText("Exported")).toBeNull();
  });

  it("stays Exported when only a mix rebuild entry lands while it runs", async () => {
    const setHistory = (head: string, groups: object[]) => {
      const project = useDawStore.getState().project;
      if (!project) throw new Error("fixture");
      act(() =>
        useDawStore.setState({
          project: {
            ...project,
            history: {
              ...project.history,
              head_id: head as HistoryEntryId,
              groups: groups as typeof project.history.groups,
            },
          },
        }),
      );
    };
    const cut = { kind: "snapshot", id: "e1", operation: "cut" };
    setHistory("e1", [cut]);
    render(<Host />);
    await pressExport();
    setHistory("p1", [
      cut,
      { kind: "snapshot", id: "p1", operation: "render_preview" },
    ]);
    await act(async () =>
      server.settle({
        ...EXPORT_FINISHED,
        result: { ...EXPORT_FINISHED.result, edit_head_id: "e1" },
      }),
    );
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(screen.queryByText("Edited since export")).toBeNull();
  });

  it("says Exporting with the job's progress while it runs", async () => {
    render(<Host />);
    await pressExport();
    await waitFor(() =>
      expect(useDawStore.getState().activityJob?.id).toBe("x1"),
    );
    act(() =>
      useDawStore.setState({
        activityJob: { ...EXPORT_STARTED, current: 1, total: 4 },
      }),
    );
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(exportButton()).toBeDisabled();
  });

  it("shows what the finished export wrote and measured, with no Reveal or Download", async () => {
    render(<Host />);
    await pressExport();
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(screen.getByText("Exported 2 files to export/")).toBeInTheDocument();
    expect(
      screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeInTheDocument();
    expect(screen.getByText("ep.wav")).toBeInTheDocument();
    expect(screen.getByText("ep.mp3")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reveal|Show in folder/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Download/ })).toBeNull();
  });

  it("keeps running when the stage is left and shows the outcome on return", async () => {
    render(<Host />);
    await pressExport();
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(screen.queryByText("Exporting")).toBeNull();
    await act(async () => server.settle(EXPORT_FINISHED));
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
  });

  it("posts the job id when Cancel is pressed", async () => {
    render(<Host />);
    await pressExport();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "x1" }]),
    );
  });

  it("says Export failed with the cause, and Try again goes back to Export", async () => {
    render(<Host />);
    await pressExport();
    await act(async () =>
      server.settle({
        ...EXPORT_STARTED,
        status: "error",
        error: "ffmpeg exited 1",
      }),
    );
    expect(await screen.findByText("Export failed")).toBeInTheDocument();
    expect(screen.getByText("ffmpeg exited 1")).toBeInTheDocument();
    server.reopen();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("Export failed")).toBeNull();
    await waitFor(() => expect(server.exportRequests).toHaveLength(2));
    expect(server.exportRequests[1]).toEqual(server.exportRequests[0]);
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
  });

  it("asks before downloading a missing model, in the page", async () => {
    renderWithModels(<Host />, { status: modelStatus(registryRows()) });
    await pressExport();
    await act(async () => server.settle(EXPORT_MODEL_NEEDED));
    expect(
      await screen.findByText(/Noise reduction \(RNNoise\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download" })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("holds Export while the settings load and exports nothing", async () => {
    server.holdConfig = new Promise(() => undefined);
    render(<Host />);
    const button = await screen.findAllByRole("button", { name: "Export" });
    expect(button[0]).toBeDisabled();
    expect(button[0]).toHaveAttribute(
      "title",
      "Wait for the settings to load.",
    );
    expect(server.exportRequests).toEqual([]);
  });

  it("shows the command's reason on a disabled Export", async () => {
    asHost("share:abc");
    render(<Host />);
    const button = await screen.findAllByRole("button", { name: "Export" });
    expect(button[0]).toBeDisabled();
    expect(button[0]).toHaveAttribute(
      "title",
      "Host-only (not available on review links)",
    );
  });
});

describe("the export command", () => {
  it("starts the export on Deliver from another stage and asks once", async () => {
    useDawStore.setState({ stage: "edit" });
    render(<Host />);
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("deliver");
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(useDawStore.getState().chrome.exportRequested).toBe(false);
    await act(async () => server.settle(EXPORT_FINISHED));
    expect(await screen.findByText("Exported")).toBeInTheDocument();
    expect(server.exportRequests).toHaveLength(1);
  });

  it("exports the formats toggled on the page when the command runs", async () => {
    render(<Host />);
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /^FLAC/ }));
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [MP3, { ext: "flac", codec: "flac" }],
    });
  });

  it("starts nothing and clears the request when no format is chosen", async () => {
    server.config = {
      config: {
        export: { wav: false, formats: [] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    render(<Host />);
    await waitFor(() =>
      expect(server.configRequests.length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(exportButton()).toHaveAttribute("title", "Choose a format first."),
    );
    expect(await execute("export.deliverables", {})).toEqual({ status: "ok" });
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
    expect(server.exportRequests).toEqual([]);
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute("title", "Choose a format first.");
    expect(screen.queryByText("Exported")).toBeNull();
  });

  it("does not start an export on a later visit when the request was never served", async () => {
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = render(<Host />);
    await execute("export.deliverables", {});
    await act(async () => undefined);
    view.unmount();
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
    release();
    render(<Host />);
    await ready();
    await act(async () => undefined);
    expect(server.exportRequests).toEqual([]);
  });

  it("waits for this visit's settings, not the ones an earlier visit loaded", async () => {
    useDawStore.setState({ stage: "edit" });
    render(<Host />);
    await waitFor(() => expect(server.configRequests).toHaveLength(1));
    await act(async () => undefined);
    server.config = {
      config: {
        export: { wav: true, formats: [{ ext: "flac", codec: "flac" }] },
        master: { integrated_lufs: -16, true_peak_db: -1.5 },
      },
    };
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    await execute("export.deliverables", {});
    await act(async () => undefined);
    expect(server.configRequests).toHaveLength(2);
    expect(server.exportRequests).toEqual([]);
    release();
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
    expect(server.exportRequests[0]).toEqual({
      path: PATH,
      formats: [{ ext: "flac", codec: "flac" }],
    });
  });

  it("waits for the settings before it starts", async () => {
    let release!: () => void;
    server.holdConfig = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<Host />);
    await execute("export.deliverables", {});
    await act(async () => undefined);
    expect(server.exportRequests).toEqual([]);
    release();
    await waitFor(() => expect(server.exportRequests).toHaveLength(1));
  });
});
