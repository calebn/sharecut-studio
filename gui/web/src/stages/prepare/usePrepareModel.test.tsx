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
  cancelBootstrap,
  fetchBootstrapJob,
  fetchBootstrapStatus,
  loadTranscriptVocabulary,
  runBootstrap,
  startPipelineRun,
  waitForBootstrapJob,
} from "../../api";
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
import { PrepareView } from "./PrepareView";
import { usePrepareModel } from "./usePrepareModel";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  loadTranscriptVocabulary: vi.fn(),
  cancelBootstrap: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  fetchBootstrapStatus: vi.fn(),
  runBootstrap: vi.fn(),
  waitForBootstrapJob: vi.fn(),
}));
vi.mock("../../hooks/usePipelineWorkingSet", () => ({
  usePipelineWorkingSet: () => ({
    cfg: pipelineConfig(),
    loadError: null,
    saveError: null,
    saving: false,
    reload: vi.fn(),
    update: vi.fn(async () => true),
    fetchFresh: vi.fn(async () => pipelineConfig()),
  }),
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
  const apiFor = (state: "missing" | "installed") => ({
    ...modelsApi({
      status: modelStatus(
        registryRows().map((row) =>
          row.id === "word-aligner" ? modelRow({ ...row, state }) : row,
        ),
      ),
      download,
    }),
    refresh,
  });
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
