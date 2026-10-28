import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTranscriptVocabulary, startPipelineRun } from "../../api";
import { ModelsContext } from "../../models/useModels";
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
import { usePrepareModel } from "./usePrepareModel";

vi.mock("../../api", async (o) => ({
  ...(await o<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  loadTranscriptVocabulary: vi.fn(),
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
const start = vi.mocked(startPipelineRun);
const api = modelsApi({
  status: modelStatus(
    registryRows().map((r) =>
      r.id === "whisper" ? modelRow({ ...r, state: "installed" }) : r,
    ),
  ),
});
const wrapper = ({ children }: { children: ReactNode }) => (
  <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
);
const P = "/tmp/test/episode.project.json";
const utt = (id: string) =>
  ({
    track_id: id,
    speaker: id,
    start_sec: 0,
    end_sec: 1,
    text: "hi",
  }) as never;
const proj = (tracks: ReturnType<typeof sampleTrack>[], spoken: string[]) =>
  minimalProject({
    tracks,
    transcript: { utterances: spoken.map(utt) } as never,
  });
beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue(
    pipelineJobSnapshot({ id: "j-new", status: "running" }),
  );
  vi.mocked(loadTranscriptVocabulary).mockResolvedValue({
    show_title: null,
    prompt_limit: null,
    prompt_primer: "",
    terms: [],
    guest_names: [],
    revision: "r",
    needs_retranscription: false,
    edited_tracks: [],
  } as never);
  useDawStore.setState({
    projectPath: P,
    pipelineJob: null,
    activityJob: null,
    ingestBusy: false,
    project: null,
  });
});

const A = sampleTrack({ id: "a" });
const B = sampleTrack({ id: "b" });

async function runFromHere(step: string) {
  useDawStore.setState({ project: proj([A, B], ["a"]) });
  const v = renderHook(() => usePrepareModel(), { wrapper });
  expect(v.result.current.view.phase).toBe("not-started");
  start.mockResolvedValueOnce(
    pipelineJobSnapshot({ id: "j-from", status: "running" }),
  );
  await act(async () => {
    v.result.current.advanced.props.onRunFromHere(step);
  });
  act(() =>
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({
        id: "j-from",
        status: "ok",
        steps: [{ name: step, status: "ok" }] as never,
      }),
    }),
  );
  return v.result;
}

describe("Run again from here and the audio an ok job covers", () => {
  it("a step after transcribe leaves an untranscribed source not started, with Start", async () => {
    const result = await runFromHere("align_tracks");
    expect(start.mock.calls[0][1]).toMatchObject({ fromStep: "align_tracks" });
    expect(result.current.view.phase).toBe("not-started");
    expect(
      result.current.view.rows.find((r) => r.id === "transcribe")?.action
        ?.label,
    ).toBe("Start");
  });

  it("from transcribe_tracks covers the audio", async () => {
    const result = await runFromHere("transcribe_tracks");
    expect(start.mock.calls[0][1]).toMatchObject({
      fromStep: "transcribe_tracks",
    });
    expect(result.current.view.phase).toBe("done");
  });
});
