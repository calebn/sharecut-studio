import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BootstrapJobSnapshot,
  type BootstrapStatus,
  cancelBootstrap,
  fetchBootstrapJob,
  fetchBootstrapStatus,
  loadTranscriptLanguageStatus,
  loadTranscriptVocabulary,
  runBootstrap,
  startPipelineRun,
  waitForBootstrapJob,
} from "../../api";
import { usePipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { ModelsProvider } from "../../models/ModelsProvider";
import type { DownloadOutcome } from "../../models/types";
import { ModelsContext, useModels } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../../test/fixtures";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import {
  modelRow,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { ApiError } from "../../utils/apiError";
import { PrepareView } from "./PrepareView";
import { usePrepareModel } from "./usePrepareModel";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  loadTranscriptVocabulary: vi.fn(),
  loadTranscriptLanguageStatus: vi.fn(),
  cancelBootstrap: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  fetchBootstrapStatus: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
}));
vi.mock("../../hooks/usePipelineWorkingSet", () => ({
  usePipelineWorkingSet: vi.fn(() => ({
    cfg: pipelineConfig(),
    loadError: null,
    saveError: null,
    saving: false,
    reload: vi.fn(),
    update: vi.fn(async () => true),
    fetchFresh: vi.fn(async () => pipelineConfig()),
  })),
}));

const PATH = "/tmp/test/episode.sharecut";
const start = vi.mocked(startPipelineRun);
function Stage() {
  const { view } = usePrepareModel();
  return <PrepareView {...view} />;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const first = deferred<DownloadOutcome>();
  const second = deferred<DownloadOutcome>();
  const download = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const refresh = vi.fn(async () => undefined);
  const apiFor = (state: "missing" | "installed") => {
    const api = modelsApi({
      status: modelStatus(
        registryRows().map((row) =>
          row.id === "word-aligner" ? modelRow({ ...row, state }) : row,
        ),
      ),
      download,
    });
    api.refresh = refresh;
    return api;
  };
  const view = render(
    <ModelsContext.Provider value={apiFor("missing")}>
      <Stage />
    </ModelsContext.Provider>,
  );
  return {
    first,
    second,
    download,
    refresh,
    publish: (state: "missing" | "installed") =>
      view.rerender(
        <ModelsContext.Provider value={apiFor(state)}>
          <Stage />
        </ModelsContext.Provider>,
      ),
    get: () =>
      fireEvent.click(screen.getByRole("button", { name: "Get word timing" })),
  };
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected live request in Prepare fixture"),
  );
  vi.clearAllMocks();
  sessionStorage.clear();
  useDawStore.setState({
    projectPath: PATH,
    ingestBusy: false,
    activityJob: null,
    project: minimalProject({
      tracks: [sampleTrack({ id: "maya" })],
      transcript: {
        utterances: [
          {
            track_id: "maya",
            speaker: "Maya",
            start: 0,
            end: 1,
            text: "Stored words",
          },
        ],
      },
    }),
    pipelineJob: pipelineJobSnapshot({
      id: "finished",
      status: "ok",
      steps: [
        {
          name: "transcribe_tracks",
          status: "ok",
          elapsed_sec: 1,
          error: null,
        },
      ],
    }),
  });
  start.mockResolvedValue(
    pipelineJobSnapshot({ id: "retimed", status: "running" }),
  );
  vi.mocked(loadTranscriptLanguageStatus).mockResolvedValue({
    language: null,
    stale_tracks: [],
    edited_stale_tracks: [],
  });
  vi.mocked(loadTranscriptVocabulary).mockResolvedValue({
    show_title: null,
    prompt_limit: null,
    prompt_primer: "",
    terms: [],
    guest_names: [],
    revision: "r1",
    needs_retranscription: false,
    edited_tracks: [],
  });
});

describe("Prepare word timing Get outcome", () => {
  it("waits for its successful completion and a fresh observation before re-timing once", async () => {
    const view = setup();
    view.get();
    expect(view.download).toHaveBeenCalledExactlyOnceWith(
      ["word-aligner"],
      undefined,
    );
    view.publish("installed");
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
    await act(async () => view.first.resolve({ kind: "ok" }));
    expect(view.refresh).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    view.publish("installed");
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith(
        PATH,
        expect.objectContaining({
          retimeWords: true,
          forceTranscribe: false,
          fromStep: "transcribe_tracks",
        }),
      ),
    );
    view.publish("installed");
    expect(start).toHaveBeenCalledOnce();
  });

  it.each<DownloadOutcome>([
    { kind: "cancelled" },
    { kind: "failed", failed: ["word-aligner"] },
    { kind: "busy" },
  ])("retires $kind before an unrelated install", async (outcome) => {
    const view = setup();
    view.get();
    await act(async () => view.first.resolve(outcome));
    view.publish("installed");
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(view.refresh).not.toHaveBeenCalled();
    view.publish("missing");
    view.get();
    await act(async () => view.second.resolve({ kind: "ok" }));
    view.publish("installed");
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith(
        PATH,
        expect.objectContaining({ retimeWords: true }),
      ),
    );
    expect(view.download).toHaveBeenCalledTimes(2);
  });

  it.each(["old-first", "old-last"] as const)(
    "ignores a superseded successful completion arriving %s",
    async (order) => {
      const view = setup();
      view.get();
      view.get();
      if (order === "old-first")
        await act(async () => view.first.resolve({ kind: "ok" }));
      await act(async () => view.second.resolve({ kind: "cancelled" }));
      if (order === "old-last")
        await act(async () => view.first.resolve({ kind: "ok" }));
      view.publish("installed");
      await act(async () => undefined);
      expect(start).not.toHaveBeenCalled();
      expect(view.refresh).not.toHaveBeenCalled();
      expect(view.download).toHaveBeenCalledTimes(2);
    },
  );

  it("retires a successful arm when a newer Get is cancelled before fresh observation", async () => {
    const view = setup();
    view.get();
    await act(async () => view.first.resolve({ kind: "ok" }));
    expect(view.refresh).toHaveBeenCalledOnce();
    view.get();
    await act(async () => view.second.resolve({ kind: "cancelled" }));
    view.publish("installed");
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
    expect(view.download).toHaveBeenCalledTimes(2);
  });

  it.each(["path", "epoch"] as const)(
    "ignores successful old-project completion after a %s change",
    async (change) => {
      const view = setup();
      view.get();
      act(() =>
        useDawStore.setState({
          projectPath: change === "path" ? "/tmp/new/episode.sharecut" : PATH,
          projectEpoch: useDawStore.getState().projectEpoch + 1,
        }),
      );
      await act(async () => view.first.resolve({ kind: "ok" }));
      view.publish("installed");
      await act(async () => undefined);
      expect(start).not.toHaveBeenCalled();
      expect(view.refresh).not.toHaveBeenCalled();
      view.publish("missing");
      view.get();
      await act(async () => view.second.resolve({ kind: "ok" }));
      view.publish("installed");
      await waitFor(() =>
        expect(start).toHaveBeenCalledExactlyOnceWith(
          change === "path" ? "/tmp/new/episode.sharecut" : PATH,
          expect.objectContaining({ retimeWords: true }),
        ),
      );
    },
  );
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("retires real-provider cancellation before an unrelated install and accepts a later Get", async () => {
  let installed = false;
  const status = () =>
    modelStatus(
      registryRows().map((row) =>
        modelRow({
          ...row,
          state:
            row.id === "word-aligner" && !installed ? "missing" : "installed",
        }),
      ),
    );
  const first = deferred<BootstrapJobSnapshot>();
  const second = deferred<BootstrapJobSnapshot>();
  const running: BootstrapJobSnapshot = {
    id: "cancelled-alignment",
    kind: "bootstrap",
    failed_components: [],
    components: ["word-aligner"],
    whisper_model: "large-v3-turbo",
    status: "running",
  };
  const next = { ...running, id: "requested-alignment" };
  vi.mocked(fetchBootstrapStatus).mockImplementation(async () => status());
  vi.mocked(fetchBootstrapJob).mockResolvedValue(null);
  vi.mocked(runBootstrap)
    .mockResolvedValueOnce({ job: running, adopted: false })
    .mockResolvedValueOnce({ job: next, adopted: false });
  vi.mocked(waitForBootstrapJob)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  vi.mocked(cancelBootstrap).mockResolvedValue({
    ...running,
    status: "cancelled",
  });
  let refresh: ReturnType<typeof useModels>["refresh"] = async () => {
    throw new Error("Models provider did not mount");
  };
  function ActualModels() {
    refresh = useModels().refresh;
    return <Stage />;
  }
  render(
    <ModelsProvider>
      <ActualModels />
    </ModelsProvider>,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Get word timing" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /cancel word timing download/i }),
  );
  await waitFor(() =>
    expect(cancelBootstrap).toHaveBeenCalledExactlyOnceWith(
      "cancelled-alignment",
    ),
  );
  await act(async () => first.resolve({ ...running, status: "cancelled" }));
  installed = true;
  await act(async () => {
    await refresh();
  });
  expect(start).not.toHaveBeenCalled();
  installed = false;
  await act(async () => {
    await refresh();
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Get word timing" }),
  );
  await waitFor(() => expect(runBootstrap).toHaveBeenCalledTimes(2));
  installed = true;
  await act(async () => second.resolve({ ...next, status: "ok" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledExactlyOnceWith(
      PATH,
      expect.objectContaining({ retimeWords: true, useWorkingSet: false }),
    ),
  );
  expect(runBootstrap).toHaveBeenNthCalledWith(1, {
    components: ["word-aligner"],
    force: false,
  });
  expect(runBootstrap).toHaveBeenNthCalledWith(2, {
    components: ["word-aligner"],
    force: false,
  });
});

it("replays Prepare's captured Fast request once after the adopted Fast target is freshly installed, keeping Best selected", async () => {
  const workingSet = vi.mocked(usePipelineWorkingSet);
  const originalImplementation = workingSet.getMockImplementation();
  if (!originalImplementation)
    throw new Error("Working-set fixture is missing");
  let config = pipelineConfig({ config: { transcribe: { model: "tiny.en" } } });
  workingSet.mockImplementation(() => ({
    cfg: config,
    loadError: null,
    saveError: null,
    saving: false,
    reload: vi.fn(),
    update: vi.fn(async () => true),
    fetchFresh: vi.fn(async () => config),
  }));
  try {
    const fast: BootstrapJobSnapshot = {
      id: "prepare-adopted-fast",
      kind: "bootstrap",
      failed_components: [],
      status: "running",
      components: ["whisper"],
      whisper_model: "tiny.en",
      download: { component: "whisper", bytes: 25_000_000, total: 75_000_000 },
    };
    const found = deferred<BootstrapJobSnapshot | null>();
    const done = deferred<BootstrapJobSnapshot>();
    const checked = deferred<BootstrapStatus>();
    let terminal = false;
    const statusFor = (variant: string, installed: boolean) =>
      modelStatus(
        registryRows().map((row) =>
          modelRow({
            ...row,
            ...(row.id === "whisper" ? { model: variant } : {}),
            state: row.id === "whisper" && !installed ? "missing" : "installed",
          }),
        ),
        { whisper_model: variant, ready: installed },
      );
    vi.mocked(fetchBootstrapStatus).mockImplementation((variant) =>
      variant === "tiny.en" && terminal
        ? checked.promise
        : Promise.resolve(
            statusFor(variant ?? "large-v3-turbo", variant !== "tiny.en"),
          ),
    );
    vi.mocked(fetchBootstrapJob).mockReturnValue(found.promise);
    vi.mocked(waitForBootstrapJob).mockReturnValue(done.promise);
    start.mockRejectedValueOnce(
      new ApiError("model needed", "model_needed", 409, {
        id: "whisper",
        variant: "tiny.en",
        label: "Whisper",
        purpose: "transcription",
        size: "75 MB",
        sizeBytes: 75_000_000,
        state: "missing",
      }),
    );
    let selected: ReturnType<typeof useModels> | undefined;
    function ActualPrepare() {
      selected = useModels();
      const prepare = usePrepareModel();
      return (
        <>
          <button onClick={() => selected?.whisper.choose("large-v3-turbo")}>
            Choose Best
          </button>
          <button
            onClick={() =>
              prepare.advanced.props.onRunFromHere("transcribe_tracks")
            }
          >
            Run captured Fast
          </button>
          <PrepareView {...prepare.view} />
        </>
      );
    }
    render(
      <ModelsProvider>
        <ActualPrepare />
      </ModelsProvider>,
    );
    await waitFor(() => expect(selected?.ready).toBe(true));
    fireEvent.click(screen.getByText("Choose Best"));
    await waitFor(() =>
      expect(fetchBootstrapStatus).toHaveBeenCalledWith("large-v3-turbo"),
    );
    await act(async () => found.resolve(fast));
    await waitFor(() =>
      expect(waitForBootstrapJob).toHaveBeenCalledWith(
        "prepare-adopted-fast",
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByText("Run captured Fast"));
    expect(await screen.findByText("25 MB of 75 MB")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Cancel the transcription model download",
      }),
    ).toBeEnabled();
    expect(start).toHaveBeenCalledTimes(1);
    const original = structuredClone(start.mock.calls[0]);
    expect(original).toEqual([
      PATH,
      expect.objectContaining({ config: { transcribe: { model: "tiny.en" } } }),
    ]);
    expect(selected?.whisper.variant).toBe("large-v3-turbo");
    config = pipelineConfig({ config: { transcribe: { model: "small.en" } } });
    terminal = true;
    await act(async () => done.resolve({ ...fast, status: "ok" }));
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => checked.resolve(statusFor("tiny.en", true)));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]).toEqual([
      original?.[0],
      { ...original?.[1], useWorkingSet: false },
    ]);
    expect(selected?.whisper.variant).toBe("large-v3-turbo");
    expect(selected?.ready).toBe(true);
    expect(
      screen.queryByRole("button", {
        name: "Cancel the transcription model download",
      }),
    ).toBeNull();
    await act(async () => {
      await selected?.refresh();
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(runBootstrap).not.toHaveBeenCalled();
  } finally {
    workingSet.mockImplementation(originalImplementation);
  }
});
